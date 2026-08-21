import type { KanbanBoard } from "../types";

/** The creator, every admin, and every participant may write cards. */
export function canEditCards(board: KanbanBoard, pubkey: string): boolean {
  if (!pubkey) return false;
  if (board.pubkey === pubkey) return true;
  return board.admins.includes(pubkey) || board.participants.includes(pubkey);
}

/**
 * Who may re-column the board, rename it, and change its roster.
 *
 * The creator plus whoever they have promoted. An admin does this by publishing
 * a patch, never by re-signing the board event, which stays addressable to the
 * creator's key alone.
 *
 * Kept in its own module because both the card services and the patch service
 * need it, and importing one from the other would close a cycle.
 */
export function canAdminister(board: KanbanBoard, pubkey: string): boolean {
  if (!pubkey) return false;
  return board.pubkey === pubkey || board.admins.includes(pubkey);
}
