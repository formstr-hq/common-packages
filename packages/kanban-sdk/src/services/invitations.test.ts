import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { createSeal, createWrap, wrapEvent } from "../crypto/nip59";
import { generateViewKey } from "../crypto/viewKey";
import { KANBAN_KINDS } from "../kinds";
import { createPrivateBoard } from "./boards";
import { fetchBoardLists } from "./boardLists";
import {
  acceptInvitation,
  dismissInvitation,
  fetchInvitations,
  sendInvitations,
} from "./invitations";

async function sharedFixture() {
  const runtime = new FakeRuntime();
  const aliceSecret = generateSecretKey();
  const bobSecret = generateSecretKey();
  const alice = makeCtx({ signer: fakeSigner(aliceSecret), runtime });
  const bob = makeCtx({ signer: fakeSigner(bobSecret), runtime });

  const { board } = await createPrivateBoard(alice, {
    title: "Q3 Roadmap",
    columns: [{ id: "col-1", name: "To Do", order: 0 }],
    private: true,
  });

  return { runtime, alice, bob, aliceSecret, bobSecret, board };
}

describe("sendInvitations", () => {
  it("publishes one wrap per recipient, p-tagged and opaque", async () => {
    const { runtime, alice, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    const wraps = runtime.published.filter((e) => e.kind === KANBAN_KINDS.inviteGiftWrap);
    expect(wraps).toHaveLength(1);
    expect(wraps[0].tags).toEqual([
      ["p", getPublicKey(bobSecret)],
      ["k", String(KANBAN_KINDS.inviteWrapType)],
    ]);
    expect(wraps[0].content).not.toContain(board.viewKey);
    expect(wraps[0].content).not.toContain(board.id);
  });

  it("publishes to the recipient's inbox relays, not only our own", async () => {
    const { runtime, alice, bobSecret, board } = await sharedFixture();
    runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.relayList,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["r", "wss://bob.example/", "read"]],
          content: "",
        },
        bobSecret,
      ),
    );

    const targets: string[][] = [];
    const spy = {
      ...runtime,
      querySync: runtime.querySync.bind(runtime),
      subscribe: runtime.subscribe.bind(runtime),
      publish: async (relays: string[], event: Parameters<typeof runtime.publish>[1]) => {
        if (event.kind === KANBAN_KINDS.inviteGiftWrap) targets.push(relays);
        return runtime.publish(relays, event);
      },
    };

    await sendInvitations({ ...alice, runtime: spy }, board, [
      { pubkey: getPublicKey(bobSecret), role: "member" },
    ]);

    expect(targets[0]).toContain("wss://bob.example/");
  });
});

describe("fetchInvitations", () => {
  it("returns a verified invitation to its recipient", async () => {
    const { alice, bob, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    const [invitation] = await fetchInvitations(bob);
    expect(invitation.coordinate).toBe(`${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`);
    expect(invitation.viewKey).toBe(board.viewKey);
    expect(invitation.role).toBe("maintainer");
    expect(invitation.inviterPubkey).toBe(board.pubkey);
  });

  it("returns nothing to a third party", async () => {
    const { runtime, alice, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "member" }]);

    const carol = makeCtx({ signer: fakeSigner(), runtime });
    expect(await fetchInvitations(carol)).toEqual([]);
  });

  it("drops a wrap whose seal signer is not the claimed inviter — forgery", async () => {
    const { runtime, bob, bobSecret, board } = await sharedFixture();

    // Mallory seals a rumor claiming Alice sent it.
    const mallory = fakeSigner(generateSecretKey());
    const forged = {
      kind: KANBAN_KINDS.inviteRumor,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["a", `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`, ""],
        ["viewKey", board.viewKey!],
        ["role", "maintainer"],
      ],
      content: "",
      pubkey: board.pubkey,
      id: "",
    };
    const seal = await createSeal(forged, mallory, getPublicKey(bobSecret));
    // Wrap it exactly as a real inviter would — `k` included — so the empty
    // result proves the seal-signer check rejected it, not that the inbox
    // filter never returned it.
    runtime.seed(
      await createWrap(seal, getPublicKey(bobSecret), KANBAN_KINDS.inviteGiftWrap, {
        tags: [["k", String(KANBAN_KINDS.inviteWrapType)]],
      }),
    );

    expect(await fetchInvitations(bob)).toEqual([]);
  });

  it("still surfaces pre-1059 wraps, which carry no k tag", async () => {
    const { runtime, alice, bob, bobSecret, board } = await sharedFixture();
    const coordinate = `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`;

    runtime.seed(
      await wrapEvent(
        {
          kind: KANBAN_KINDS.inviteRumor,
          content: "",
          tags: [
            ["a", coordinate, ""],
            ["viewKey", board.viewKey!],
            ["role", "member"],
          ],
        },
        await alice.getSigner(),
        getPublicKey(bobSecret),
        // The old wire kind, and no `k` tag — exactly what shipped before.
        KANBAN_KINDS.inviteWrapType,
      ),
    );

    const [invitation] = await fetchInvitations(bob);
    expect(invitation.coordinate).toBe(coordinate);
    expect(invitation.viewKey).toBe(board.viewKey);
  });

  it("collapses repeat invitations to the same board into one pending entry", async () => {
    const { alice, bob, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "member" }]);
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    // Both wraps were written in the same second, so they are the same age and
    // either may win — what must hold is that the user sees one item, not two.
    expect(await fetchInvitations(bob)).toHaveLength(1);
  });

  it("prefers a strictly newer invitation — the re-invite after a key rotation", async () => {
    const { runtime, alice, bob, bobSecret, board } = await sharedFixture();
    const coordinate = `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`;

    // An older invitation carrying a key that has since been rotated away.
    runtime.seed(
      await wrapEvent(
        {
          kind: KANBAN_KINDS.inviteRumor,
          created_at: Math.floor(Date.now() / 1000) - 3600,
          content: "",
          tags: [
            ["a", coordinate, ""],
            ["viewKey", generateViewKey().nsec],
            ["role", "member"],
          ],
        },
        await alice.getSigner(),
        getPublicKey(bobSecret),
        KANBAN_KINDS.inviteGiftWrap,
        { tags: [["k", String(KANBAN_KINDS.inviteWrapType)]] },
      ),
    );
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    const [invitation] = await fetchInvitations(bob);
    expect(invitation.viewKey).toBe(board.viewKey);
    expect(invitation.role).toBe("maintainer");
  });

  it("hides an invitation the user already accepted", async () => {
    const { alice, bob, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);

    expect(await fetchInvitations(bob)).toEqual([]);
  });

  it("hides an invitation the user dismissed", async () => {
    const { alice, bob, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "member" }]);

    const [invitation] = await fetchInvitations(bob);
    await dismissInvitation(bob, invitation);

    expect(await fetchInvitations(bob)).toEqual([]);
  });
});

describe("acceptInvitation", () => {
  it("stores the board ref, with its key and role, in the recipient's own list", async () => {
    const { alice, bob, bobSecret, board } = await sharedFixture();
    await sendInvitations(alice, board, [{ pubkey: getPublicKey(bobSecret), role: "maintainer" }]);

    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);

    const [list] = await fetchBoardLists(bob);
    expect(list.boards).toEqual([
      {
        coordinate: invitation.coordinate,
        relayHint: invitation.relayHint,
        viewKey: board.viewKey,
        role: "maintainer",
      },
    ]);
  });

  it("refuses an invitation whose board cannot be decrypted with the offered key", async () => {
    const { runtime, bob, bobSecret } = await sharedFixture();
    const mallory = fakeSigner(generateSecretKey());

    runtime.seed(
      await wrapEvent(
        {
          kind: KANBAN_KINDS.inviteRumor,
          content: "",
          tags: [
            ["a", `${KANBAN_KINDS.privateBoard}:${"9".repeat(64)}:ghost`, ""],
            ["viewKey", generateViewKey().nsec],
          ],
        },
        mallory,
        getPublicKey(bobSecret),
        KANBAN_KINDS.inviteGiftWrap,
        { tags: [["k", String(KANBAN_KINDS.inviteWrapType)]] },
      ),
    );

    const [invitation] = await fetchInvitations(bob);
    await expect(acceptInvitation(bob, invitation)).rejects.toThrow(/could not be read/);
  });
});
