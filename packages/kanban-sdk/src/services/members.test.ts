import { generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { KANBAN_KINDS } from "../kinds";
import { createPrivateBoard, fetchPrivateBoards } from "./boards";
import { fetchInvitations } from "./invitations";
import { fetchMembers, inviteMembers, removeMember } from "./members";

async function fixture() {
  const runtime = new FakeRuntime();
  const alice = makeCtx({ signer: fakeSigner(generateSecretKey()), runtime });
  const bobSecret = generateSecretKey();
  const bob = makeCtx({ signer: fakeSigner(bobSecret), runtime });
  const { board } = await createPrivateBoard(alice, {
    title: "Q3",
    columns: [{ id: "col-1", name: "To Do", order: 0 }],
    private: true,
  });
  return { runtime, alice, bob, bobPubkey: getPublicKey(bobSecret), board };
}

describe("fetchMembers", () => {
  it("reports the owner even though the board never lists them", async () => {
    const { alice, board } = await fixture();
    expect(await fetchMembers(alice, board)).toEqual([{ pubkey: board.pubkey, role: "owner" }]);
  });
});

describe("inviteMembers", () => {
  it("adds the pubkey to the board and sends them the key", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const updated = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);

    expect(updated.maintainers).toEqual([bobPubkey]);
    expect(await fetchMembers(alice, updated)).toEqual([
      { pubkey: board.pubkey, role: "owner" },
      { pubkey: bobPubkey, role: "maintainer" },
    ]);
    expect((await fetchInvitations(bob))[0].viewKey).toBe(board.viewKey);
  });

  it("puts a member in the member set, not the maintainer set", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const updated = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "member" }]);

    expect(updated.members).toEqual([bobPubkey]);
    expect(updated.maintainers).toEqual([]);
  });

  it("is idempotent — re-inviting does not duplicate the entry", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const once = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const twice = await inviteMembers(alice, once, [{ pubkey: bobPubkey, role: "maintainer" }]);

    expect(twice.maintainers).toEqual([bobPubkey]);
  });

  it("moves someone between roles rather than listing them twice", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const asMember = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "member" }]);
    const promoted = await inviteMembers(alice, asMember, [
      { pubkey: bobPubkey, role: "maintainer" },
    ]);

    expect(promoted.maintainers).toEqual([bobPubkey]);
    expect(promoted.members).toEqual([]);
  });

  it("refuses when the caller is not the board author", async () => {
    const { bob, bobPubkey, board } = await fixture();
    await expect(inviteMembers(bob, board, [{ pubkey: bobPubkey, role: "member" }])).rejects.toThrow(
      /is not the author/,
    );
  });
});

describe("removeMember", () => {
  it("drops them from the board and publishes a kind 84", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const without = await removeMember(alice, withBob, bobPubkey);

    expect(without.maintainers).toEqual([]);

    const removal = (alice.runtime as FakeRuntime).published.find(
      (e) => e.kind === KANBAN_KINDS.membershipRemoval,
    )!;
    expect(removal.tags).toContainEqual(["a", `32301:${board.pubkey}:${board.id}`]);
    expect(removal.tags).toContainEqual(["p", bobPubkey]);
  });

  it("is a notification, not a revocation — the old key still opens the board", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    await removeMember(alice, withBob, bobPubkey);

    // Doc 05 §8: removal alone takes no key away. Only rotateBoardKey does.
    const stillReadable = await fetchPrivateBoards(alice);
    expect(stillReadable[0].viewKey).toBe(board.viewKey);
  });
});
