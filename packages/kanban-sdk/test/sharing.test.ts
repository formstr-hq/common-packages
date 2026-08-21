import { generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { KanbanSDK } from "../src/KanbanSDK";
import { FakeRuntime, fakeSigner } from "./helpers";

function twoUsers() {
  const runtime = new FakeRuntime();
  const aliceKey = generateSecretKey();
  const bobKey = generateSecretKey();
  const relays = ["wss://test.relay/"];
  return {
    runtime,
    bobPubkey: getPublicKey(bobKey),
    alice: new KanbanSDK({ signer: fakeSigner(aliceKey), runtime, relays }),
    bob: new KanbanSDK({ signer: fakeSigner(bobKey), runtime, relays }),
  };
}

describe("sharing a private board end to end", () => {
  it("invites, accepts, collaborates, comments, and rotates the key", async () => {
    const { alice, bob, bobPubkey } = twoUsers();

    const board = await alice.createBoard({
      title: "Q3 Roadmap",
      columns: [
        { id: "col-1", name: "To Do", order: 0 },
        { id: "col-2", name: "Done", order: 1 },
      ],
      private: true,
    });
    const aliceCard = await alice.createCard(board, { title: "Ship the SDK", status: "col-1" });

    // 1. Invite Bob as a maintainer.
    const shared = await alice.invite(board, [{ pubkey: bobPubkey, role: "participant" }]);
    expect(await alice.fetchMembers(shared)).toHaveLength(2);

    // 2. Bob sees exactly one pending invitation and accepts it.
    const pending = await bob.fetchInvitations();
    expect(pending).toHaveLength(1);
    expect(pending[0].inviterPubkey).toBe(board.pubkey);
    await bob.acceptInvitation(pending[0]);
    expect(await bob.fetchInvitations()).toEqual([]);

    // 3. Bob now reaches the board and its cards from his own list alone.
    const [bobsBoard] = await bob.fetchPrivateBoards();
    expect(bobsBoard.title).toBe("Q3 Roadmap");
    expect((await bob.fetchCards(bobsBoard)).map((c) => c.title)).toEqual(["Ship the SDK"]);

    // 4. Bob writes a card and comments on Alice's.
    await bob.createCard(bobsBoard, { title: "Write the docs", status: "col-1" });
    await bob.createComment(bobsBoard, aliceCard.id, { content: "starting Monday" });

    const aliceView = (await alice.fetchPrivateBoards())[0];
    expect((await alice.fetchCards(aliceView)).map((c) => c.title).sort()).toEqual([
      "Ship the SDK",
      "Write the docs",
    ]);
    expect((await alice.fetchComments(aliceView, aliceCard.id)).map((c) => c.content)).toEqual([
      "starting Monday",
    ]);

    // 5. Alice removes Bob and rotates the key.
    const result = await alice.rotateBoardKey(aliceView, { remove: [bobPubkey] });
    expect(result.board.viewKey).not.toBe(board.viewKey);

    // The board survives whole, and Bob's card is still attributed to Bob even
    // though Alice re-signed it.
    const after = await alice.fetchCards(result.board);
    expect(after.map((c) => c.title).sort()).toEqual(["Ship the SDK", "Write the docs"]);
    const bobsCard = after.find((c) => c.title === "Write the docs")!;
    expect(bobsCard.pubkey).toBe(board.pubkey);
    expect(bobsCard.authorPubkey).toBe(bobPubkey);
    expect((await alice.fetchComments(result.board, aliceCard.id))[0].content).toBe(
      "starting Monday",
    );

    // 6. Bob is out: his stored key opens nothing, and he was not re-invited.
    expect(await bob.fetchPrivateBoards()).toEqual([]);
    expect(await bob.fetchInvitations()).toEqual([]);
  });

  it("a declined invitation stays declined", async () => {
    const { alice, bob, bobPubkey } = twoUsers();
    const board = await alice.createBoard({ title: "Q3", columns: [], private: true });
    await alice.invite(board, [{ pubkey: bobPubkey, role: "participant" }]);

    const [invitation] = await bob.fetchInvitations();
    await bob.dismissInvitation(invitation);

    expect(await bob.fetchInvitations()).toEqual([]);
    expect(await bob.fetchPrivateBoards()).toEqual([]);
  });

  it("never puts a view key or a board title on the wire in the clear", async () => {
    const { alice, runtime, bobPubkey } = twoUsers();
    const board = await alice.createBoard({
      title: "Acquisition of Foo Corp",
      columns: [{ id: "col-1", name: "Legal", order: 0 }],
      private: true,
    });
    const shared = await alice.invite(board, [{ pubkey: bobPubkey, role: "participant" }]);
    const card = await alice.createCard(shared, { title: "Term sheet", status: "col-1" });
    await alice.createComment(shared, card.id, { content: "signed" });

    const secrets = [board.viewKey!, "Acquisition", "Foo Corp", "Legal", "Term sheet", "signed"];
    for (const event of runtime.published) {
      for (const secret of secrets) {
        expect(event.content).not.toContain(secret);
        expect(JSON.stringify(event.tags)).not.toContain(secret);
      }
    }
  });
});
