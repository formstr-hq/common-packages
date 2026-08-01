import { generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { KANBAN_KINDS } from "../kinds";
import { createPrivateBoard, fetchPrivateBoards } from "./boards";
import { fetchBoardLists } from "./boardLists";
import { boardPointer, createPrivateCard, fetchPrivateCards } from "./cards";
import { createComment, fetchComments } from "./comments";
import { acceptInvitation, fetchInvitations } from "./invitations";
import {
  fetchMembers,
  fetchRemovalNotices,
  inviteMembers,
  removeMember,
  rotateBoardKey,
} from "./members";

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
    // Blinded, so a relay cannot tell which board this is or who left.
    expect(removal.tags).toContainEqual(["b", boardPointer(board, board.viewKey!)]);
    expect(JSON.stringify(removal)).not.toContain(board.id);
    expect(JSON.stringify(removal)).not.toContain(bobPubkey);
  });

  it("lets the removed member find the notice with one query across every board", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await removeMember(alice, withBob, bobPubkey);

    const notices = await fetchRemovalNotices(bob);
    expect(notices.map((n) => n.coordinate)).toEqual([`32301:${board.pubkey}:${board.id}`]);
  });

  it("ignores a removal notice that did not come from the board owner", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);

    // Bob holds the view key, so he can compute the pointer — but forging an
    // eviction must not work, or any member could remove any other.
    const forged = await (await bob.getSigner()).signEvent({
      kind: KANBAN_KINDS.membershipRemoval,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["b", boardPointer(withBob, board.viewKey!)]],
      content: "",
    });
    (bob.runtime as FakeRuntime).seed(forged);

    expect(await fetchRemovalNotices(bob)).toEqual([]);
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

describe("rotateBoardKey", () => {
  it("mints a new key, re-encrypts everything, and leaves the board readable", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    await createPrivateCard(alice, withBob, { title: "Ship it", status: "col-1" });

    const result = await rotateBoardKey(alice, withBob, { remove: [bobPubkey] });

    expect(result.board.viewKey).not.toBe(board.viewKey);
    expect(result.cardsRewritten).toBe(1);
    expect(result.board.maintainers).toEqual([]);
    expect((await fetchPrivateCards(alice, result.board)).map((c) => c.title)).toEqual(["Ship it"]);
  });

  it("changes the blinded pointer, so cards move to a new label", async () => {
    const { alice, board } = await fixture();
    await createPrivateCard(alice, board, { title: "Ship it", status: "col-1" });
    const before = boardPointer(board, board.viewKey!);

    const result = await rotateBoardKey(alice, board);
    expect(boardPointer(result.board, result.board.viewKey!)).not.toBe(before);
  });

  it("cuts off the removed member: their stored key no longer opens the board", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await createPrivateCard(alice, withBob, { title: "secret", status: "col-1" });

    await rotateBoardKey(alice, withBob, { remove: [bobPubkey] });

    // Bob's list still holds the OLD key; it opens nothing current.
    expect(await fetchPrivateBoards(bob)).toEqual([]);
  });

  it("re-invites everyone who remains, with the new key", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [first] = await fetchInvitations(bob);
    await acceptInvitation(bob, first);

    const result = await rotateBoardKey(alice, withBob);
    expect(result.invited).toEqual([bobPubkey]);

    // Bob is re-invited with the new key and can accept again.
    const [second] = await fetchInvitations(bob);
    expect(second.viewKey).toBe(result.board.viewKey);
    await acceptInvitation(bob, second);
    expect((await fetchPrivateBoards(bob))[0].title).toBe("Q3");
  });

  it("records the original author on a card it did not write", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);

    const bobsBoard = (await fetchPrivateBoards(bob))[0];
    await createPrivateCard(bob, bobsBoard, { title: "Bob wrote this", status: "col-1" });

    const result = await rotateBoardKey(alice, withBob);
    const [card] = await fetchPrivateCards(alice, result.board);

    expect(card.title).toBe("Bob wrote this");
    expect(card.pubkey).toBe(board.pubkey); // signed by Alice, the rotator
    expect(card.authorPubkey).toBe(bobPubkey); // but attributed to Bob
    expect(card.rotated).toBe(true);
  });

  it("does not overwrite an author recorded by an earlier rotation", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "maintainer" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await createPrivateCard(bob, (await fetchPrivateBoards(bob))[0], {
      title: "Bob wrote this",
      status: "col-1",
    });

    const once = await rotateBoardKey(alice, withBob);
    const twice = await rotateBoardKey(alice, once.board);

    expect((await fetchPrivateCards(alice, twice.board))[0].authorPubkey).toBe(bobPubkey);
  });

  it("carries comments across the rotation too", async () => {
    const { alice, board } = await fixture();
    const card = await createPrivateCard(alice, board, { title: "Ship it", status: "col-1" });
    await createComment(alice, board, card.id, { content: "shipping Friday" });

    const result = await rotateBoardKey(alice, board);
    expect(result.commentsRewritten).toBe(1);
    expect((await fetchComments(alice, result.board, card.id)).map((c) => c.content)).toEqual([
      "shipping Friday",
    ]);
  });

  it("updates the owner's own board-list ref to the new key", async () => {
    const { alice, board } = await fixture();
    const result = await rotateBoardKey(alice, board);

    const [list] = await fetchBoardLists(alice);
    expect(list.boards[0].viewKey).toBe(result.board.viewKey);
  });

  it("refuses a rotator who is not the board author", async () => {
    const { bob, board } = await fixture();
    await expect(rotateBoardKey(bob, board)).rejects.toThrow(/is not the author/);
  });
});
