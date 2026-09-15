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
  demoteAdmin,
  promoteToAdmin,
  removeMember,
  rotateBoardKey,
} from "./members";
import { updatePrivateBoard } from "./boards";

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
    const updated = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);

    expect(updated.participants).toEqual([bobPubkey]);
    expect(await fetchMembers(alice, updated)).toEqual([
      { pubkey: board.pubkey, role: "owner" },
      { pubkey: bobPubkey, role: "participant" },
    ]);
    expect((await fetchInvitations(bob))[0].viewKey).toBe(board.viewKey);
  });

  it("puts an admin in the admin set, not the participant set", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const updated = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "admin" }]);

    expect(updated.admins).toEqual([bobPubkey]);
    expect(updated.participants).toEqual([]);
  });

  it("is idempotent — re-inviting does not duplicate the entry", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const once = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const twice = await inviteMembers(alice, once, [{ pubkey: bobPubkey, role: "participant" }]);

    expect(twice.participants).toEqual([bobPubkey]);
  });

  it("moves someone between roles rather than listing them twice", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const asParticipant = await inviteMembers(alice, board, [
      { pubkey: bobPubkey, role: "participant" },
    ]);
    const promoted = await inviteMembers(alice, asParticipant, [
      { pubkey: bobPubkey, role: "admin" },
    ]);

    expect(promoted.admins).toEqual([bobPubkey]);
    expect(promoted.participants).toEqual([]);
  });

  it("refuses a caller the board does not list as an admin", async () => {
    const { bob, bobPubkey, board } = await fixture();
    await expect(
      inviteMembers(bob, board, [{ pubkey: bobPubkey, role: "participant" }]),
    ).rejects.toThrow(/is not an admin/);
  });

  it("refuses to let an admin hand out their own rank", async () => {
    // The fold reads the admin list from the base board and nowhere else, so an
    // admin who could promote a peer would make that list meaningless.
    const { alice, bob, bobPubkey, board } = await fixture();
    const asAdmin = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "admin" }]);

    await expect(
      inviteMembers(bob, asAdmin, [{ pubkey: "9".repeat(64), role: "admin" }]),
    ).rejects.toThrow(/is not the author/);
  });
});

describe("removeMember", () => {
  it("drops them from the board and publishes a kind 84", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const { board: without, rotated } = await removeMember(alice, withBob, bobPubkey);

    expect(without.participants).toEqual([]);

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
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await removeMember(alice, withBob, bobPubkey);

    const notices = await fetchRemovalNotices(bob);
    expect(notices.map((n) => n.coordinate)).toEqual([`32301:${board.pubkey}:${board.id}`]);
  });

  it("ignores a removal notice that did not come from the board owner", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
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

  it("rotates by default, so the removed member's key stops working", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await createPrivateCard(alice, withBob, { title: "Ship it", status: "col-1" });

    const { board: without, rotated } = await removeMember(alice, withBob, bobPubkey);

    expect(without.viewKey).not.toBe(board.viewKey);
    expect(without.participants).toEqual([]);
    // Bob's stored key is the retired one: it no longer points anywhere.
    expect(await fetchPrivateBoards(bob)).toEqual([]);
    // Alice keeps hers, re-encrypted.
    expect((await fetchPrivateCards(alice, without)).map((c) => c.title)).toEqual(["Ship it"]);
  });

  it("with rotate: false it only stages the removal — the old key still opens the board", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);

    const { board: without, rotated } = await removeMember(alice, withBob, bobPubkey, { rotate: false });

    // Doc 05 §8: dropping the tag takes no key away. This is the batching path,
    // and until rotateBoardKey runs the removed member still reads everything.
    expect(without.participants).toEqual([]);
    expect(without.viewKey).toBe(board.viewKey);
    expect((await fetchPrivateBoards(bob))[0].viewKey).toBe(board.viewKey);
  });
});

describe("rotateBoardKey", () => {
  it("mints a new key, re-encrypts everything, and leaves the board readable", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    await createPrivateCard(alice, withBob, { title: "Ship it", status: "col-1" });

    const result = await rotateBoardKey(alice, withBob, { remove: [bobPubkey] });

    expect(result.board.viewKey).not.toBe(board.viewKey);
    expect(result.cardsRewritten).toBe(1);
    expect(result.board.participants).toEqual([]);
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
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
    const [invitation] = await fetchInvitations(bob);
    await acceptInvitation(bob, invitation);
    await createPrivateCard(alice, withBob, { title: "secret", status: "col-1" });

    await rotateBoardKey(alice, withBob, { remove: [bobPubkey] });

    // Bob's list still holds the OLD key; it opens nothing current.
    expect(await fetchPrivateBoards(bob)).toEqual([]);
  });

  it("re-invites everyone who remains, with the new key", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
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
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
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
    const withBob = await inviteMembers(alice, board, [{ pubkey: bobPubkey, role: "participant" }]);
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

describe("promoteToAdmin", () => {
  it("moves a participant up, out of the participant list", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const withBob = await inviteMembers(alice, board, [
      { pubkey: bobPubkey, role: "participant" },
    ]);

    const promoted = await promoteToAdmin(alice, withBob, bobPubkey);

    expect(promoted.admins).toEqual([bobPubkey]);
    expect(promoted.participants).toEqual([]);
  });

  it("lets the new admin re-column a board they do not own", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const promoted = await promoteToAdmin(alice, board, bobPubkey);

    const patched = await updatePrivateBoard(bob, promoted, {
      columns: [{ id: "c2", name: "Blocked", order: 1 }],
    });

    expect(patched.columns.map((c) => c.id)).toContain("c2");
  });

  it("refuses anyone but the creator", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const promoted = await promoteToAdmin(alice, board, bobPubkey);

    await expect(promoteToAdmin(bob, promoted, "9".repeat(64))).rejects.toThrow(
      /is not the author/,
    );
  });

  it("is a no-op for someone who is already an admin", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const once = await promoteToAdmin(alice, board, bobPubkey);
    const twice = await promoteToAdmin(alice, once, bobPubkey);

    expect(twice.admins).toEqual([bobPubkey]);
  });
});

describe("demoteAdmin", () => {
  it("leaves them a participant rather than off the board", async () => {
    // Demotion is about the board, not their cards. Dropping them entirely would
    // cost them write access nobody asked to remove.
    const { alice, bobPubkey, board } = await fixture();
    const promoted = await promoteToAdmin(alice, board, bobPubkey);

    const demoted = await demoteAdmin(alice, promoted, bobPubkey);

    expect(demoted.admins).toEqual([]);
    expect(demoted.participants).toEqual([bobPubkey]);
  });

  it("stops their patches from applying", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const promoted = await promoteToAdmin(alice, board, bobPubkey);
    await updatePrivateBoard(bob, promoted, { title: "Bob's title" });

    const demoted = await demoteAdmin(alice, promoted, bobPubkey);

    expect(demoted.title).not.toBe("Bob's title");
  });

  it("refuses anyone but the creator", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const promoted = await promoteToAdmin(alice, board, bobPubkey);

    await expect(demoteAdmin(bob, promoted, bobPubkey)).rejects.toThrow(/is not the author/);
  });

  it("is a no-op for someone who was never an admin", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const demoted = await demoteAdmin(alice, board, bobPubkey);
    expect(demoted.participants).not.toContain(bobPubkey);
  });
});

describe("an admin removing somebody", () => {
  it("takes them off the roster but reports that nothing was revoked", async () => {
    const { alice, bob, bobPubkey, board } = await fixture();
    const carol = getPublicKey(generateSecretKey());

    const staffed = await inviteMembers(alice, board, [
      { pubkey: bobPubkey, role: "admin" },
      { pubkey: carol, role: "participant" },
    ]);

    const { board: without, rotated } = await removeMember(bob, staffed, carol);

    expect(without.participants).not.toContain(carol);
    // Rotation republishes the board event, so an admin cannot do it. Reporting
    // otherwise would tell the user access was cut off when it was not.
    expect(rotated).toBe(false);
    expect(without.viewKey).toBe(board.viewKey);
  });

  it("still rotates when the creator does it", async () => {
    const { alice, bobPubkey, board } = await fixture();
    const staffed = await inviteMembers(alice, board, [
      { pubkey: bobPubkey, role: "participant" },
    ]);

    const { rotated, board: without } = await removeMember(alice, staffed, bobPubkey);

    expect(rotated).toBe(true);
    expect(without.viewKey).not.toBe(board.viewKey);
  });
});
