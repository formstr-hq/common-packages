import { boardCoordinate } from "../codec/board";
import type { KanbanCtx } from "../contracts";
import { nextCreatedAt } from "../discovery/dedupe";
import { KANBAN_KINDS } from "../kinds";
import type { BoardRole, KanbanBoard } from "../types";
import { updatePrivateBoard } from "./boards";
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
