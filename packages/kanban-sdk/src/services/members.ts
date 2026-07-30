import { boardCoordinate, buildPrivateBoardTags } from "../codec/board";
import { NotBoardOwnerError, type KanbanCtx } from "../contracts";
import { blindedPointer } from "../crypto/blindedPointer";
import { encryptWithViewKey, generateViewKey } from "../crypto/viewKey";
import { nextCreatedAt } from "../discovery/dedupe";
import { KANBAN_KINDS } from "../kinds";
import type { BoardRole, KanbanBoard } from "../types";
import { fetchBoardLists, updateBoardList } from "./boardLists";
import { updatePrivateBoard } from "./boards";
import { fetchPrivateCards } from "./cards";
import { fetchComments } from "./comments";
import { sendInvitations } from "./invitations";

export interface BoardMember {
  pubkey: string;
  role: BoardRole;
}

/**
 * Everyone with access, owner first. The board author is implicitly a maintainer
 * and is never listed in the payload (doc 05 §3), so it must be added here or the
 * owner appears to have no access to their own board.
 */
export async function fetchMembers(_ctx: KanbanCtx, board: KanbanBoard): Promise<BoardMember[]> {
  return [
    { pubkey: board.pubkey, role: "owner" as const },
    ...board.maintainers.map((pubkey) => ({ pubkey, role: "maintainer" as const })),
    ...board.members.map((pubkey) => ({ pubkey, role: "member" as const })),
  ];
}

/**
 * Add people to the board and gift-wrap them the key. Both halves are required:
 * the board tags decide what honest clients display, and the wrap is the only way
 * the key travels.
 *
 * Editing the board is the author's alone (doc 05 §7), so `updatePrivateBoard`
 * rejects anyone else before an invitation goes out.
 */
export async function inviteMembers(
  ctx: KanbanCtx,
  board: KanbanBoard,
  invitees: { pubkey: string; role: "maintainer" | "member" }[],
  message = "",
): Promise<KanbanBoard> {
  if (invitees.length === 0) return board;

  const promoted = new Set(invitees.map((i) => i.pubkey));
  // Drop each invitee from both sets first, so a role change moves them rather
  // than leaving them listed twice with conflicting roles.
  const maintainers = board.maintainers.filter((p) => !promoted.has(p));
  const members = board.members.filter((p) => !promoted.has(p));

  for (const invitee of invitees) {
    if (invitee.role === "maintainer") maintainers.push(invitee.pubkey);
    else members.push(invitee.pubkey);
  }

  const updated = await updatePrivateBoard(ctx, board, { maintainers, members });
  await sendInvitations(ctx, updated, invitees, message);
  return updated;
}

/**
 * Remove someone from the board's tags and publish the kind-84 notification of
 * doc 05 §8.
 *
 * **This does not revoke anything.** The removed person still holds the view key
 * and can still decrypt every version of the board and its cards published under
 * it, past and future. Only `rotateBoardKey` actually cuts access, and even that
 * cannot un-read what they have already read.
 */
export async function removeMember(
  ctx: KanbanCtx,
  board: KanbanBoard,
  pubkey: string,
): Promise<KanbanBoard> {
  const updated = await updatePrivateBoard(ctx, board, {
    maintainers: board.maintainers.filter((p) => p !== pubkey),
    members: board.members.filter((p) => p !== pubkey),
  });

  const signer = await ctx.getSigner();
  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.membershipRemoval,
    created_at: nextCreatedAt(),
    tags: [
      ["a", boardCoordinate(board)],
      ["e", board.eventId],
      ["p", pubkey],
      ["k", String(KANBAN_KINDS.privateBoard)],
    ],
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);

  return updated;
}

export interface RotationResult {
  board: KanbanBoard;
  cardsRewritten: number;
  commentsRewritten: number;
  /** Remaining members who were re-invited with the new key. */
  invited: string[];
}

/** Stamp the real author onto a payload the rotator is about to re-sign. */
function withRotatedAuthor(innerTags: string[][], originalAuthor: string): string[][] {
  // Preserve an author recorded by an EARLIER rotation: overwriting it would
  // attribute the card to whoever rotated most recently.
  if (innerTags.some((t) => t[0] === "rotated-author")) return innerTags;
  return [...innerTags, ["rotated-author", originalAuthor]];
}

/**
 * Cut off removed members by re-keying the whole board — doc 05 §8.
 *
 * Steps: mint a key, re-encrypt the board without the removed pubkeys,
 * re-encrypt and re-point every card and comment, update our own list ref, and
 * re-invite everyone remaining.
 *
 * Three costs, all inherent to the view-key model and none of them bugs:
 *  - **O(cards).** Every card and comment is republished.
 *  - **Not atomic.** An interrupted rotation leaves a board split across two keys;
 *    re-running it finishes the job, since anything already re-encrypted is found
 *    under the new pointer and anything missed is still under the old one.
 *  - **No retroactive revocation.** What the removed member already read, they
 *    keep. Rotation stops future reads, nothing more (doc 07 §B1).
 */
export async function rotateBoardKey(
  ctx: KanbanCtx,
  board: KanbanBoard,
  opts: { remove?: string[] } = {},
): Promise<RotationResult> {
  const signer = await ctx.getSigner();
  const rotator = await signer.getPublicKey();
  if (rotator !== board.pubkey) {
    throw new NotBoardOwnerError(rotator, boardCoordinate(board));
  }

  // Read everything under the OLD key before anything changes.
  const cards = await fetchPrivateCards(ctx, board);
  const comments = await fetchComments(ctx, board);

  const removed = new Set(opts.remove ?? []);
  const maintainers = board.maintainers.filter((p) => !removed.has(p));
  const members = board.members.filter((p) => !removed.has(p));

  const next = generateViewKey();
  const coordinate = boardCoordinate(board);
  const pointer = blindedPointer(next.pubkey, coordinate);

  // 1. The board itself, under the new key and without the removed pubkeys.
  const inner = buildPrivateBoardTags(
    {
      title: board.title,
      description: board.description,
      columns: board.columns,
      maintainers,
      members,
      noZap: board.noZap,
    },
    board.id,
  );
  const signedBoard = await signer.signEvent({
    kind: KANBAN_KINDS.privateBoard,
    created_at: nextCreatedAt(board.createdAt),
    tags: [["d", board.id]],
    content: await encryptWithViewKey(next.nsec, JSON.stringify(inner)),
  });
  await ctx.runtime.publish(ctx.relays, signedBoard);

  const rotated: KanbanBoard = {
    ...board,
    eventId: signedBoard.id,
    createdAt: signedBoard.created_at,
    maintainers,
    members,
    viewKey: next.nsec,
    rawTags: inner,
  };

  // 2. Every card, re-encrypted and re-pointered. Cards written by someone else
  // cannot be re-signed by us, so they are republished under our pubkey with the
  // original author recorded in the payload.
  for (const card of cards) {
    const payload =
      card.authorPubkey === rotator
        ? card.rawTags
        : withRotatedAuthor(card.rawTags, card.authorPubkey);

    const signed = await signer.signEvent({
      kind: KANBAN_KINDS.privateCard,
      created_at: nextCreatedAt(card.createdAt),
      tags: [
        ["d", card.id],
        ["b", pointer],
      ],
      content: await encryptWithViewKey(next.nsec, JSON.stringify(payload)),
    });
    await ctx.runtime.publish(ctx.relays, signed);
  }

  // 3. Comments, same treatment. They share the card's pointer and key.
  for (const comment of comments) {
    const payload =
      comment.authorPubkey === rotator
        ? comment.rawTags
        : withRotatedAuthor(comment.rawTags, comment.authorPubkey);

    const signed = await signer.signEvent({
      kind: KANBAN_KINDS.privateComment,
      created_at: nextCreatedAt(comment.createdAt),
      tags: [
        ["d", comment.id],
        ["b", pointer],
      ],
      content: await encryptWithViewKey(next.nsec, JSON.stringify(payload)),
    });
    await ctx.runtime.publish(ctx.relays, signed);
  }

  // 4. Our own list ref, so the new key survives a refresh.
  for (const list of await fetchBoardLists(ctx)) {
    if (!list.boards.some((ref) => ref.coordinate === coordinate)) continue;
    await updateBoardList(ctx, {
      ...list,
      boards: list.boards.map((ref) =>
        ref.coordinate === coordinate ? { ...ref, viewKey: next.nsec } : ref,
      ),
    });
  }

  // 5. Hand the new key to everyone who is left.
  const remaining = [
    ...maintainers.map((pubkey) => ({ pubkey, role: "maintainer" as const })),
    ...members.map((pubkey) => ({ pubkey, role: "member" as const })),
  ];
  await sendInvitations(ctx, rotated, remaining);

  return {
    board: rotated,
    cardsRewritten: cards.length,
    commentsRewritten: comments.length,
    invited: remaining.map((r) => r.pubkey),
  };
}
