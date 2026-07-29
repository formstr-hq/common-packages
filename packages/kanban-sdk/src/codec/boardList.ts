import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { BoardListRef, BoardRole, KanbanBoardList } from "../types";

/**
 * Board-list (kind 32303) content codec — doc 05 §5.
 *
 * The decrypted content is a NIP-style **tags array**, not a JSON object, so it
 * reads the same way NIP-52E's calendar list (32123) does:
 *
 *   [["title", "Work"],
 *    ["a", "32301:<author>:<d>", "<relay>", "nsec1…", "maintainer"]]
 *
 * This array is the only durable home a board's view key has. Everything else —
 * the board event, its cards — is unreadable without it.
 */

export const DEFAULT_BOARD_LIST_TITLE = "My Boards";

const ROLES: readonly BoardRole[] = ["owner", "maintainer", "member"];

/**
 * `d` derivation, kept identical to NIP-52E for cross-app familiarity. It is
 * deterministic and therefore guessable, which is fine ONLY because a list title
 * is generic. Board and card `d` tags must be random instead (doc 05 §3).
 */
export function boardListDTag(title: string, createdAt: number): string {
  return bytesToHex(sha256(utf8ToBytes(`${title}:${createdAt}`))).slice(0, 16);
}

export function buildBoardRef(ref: BoardListRef): string[] {
  return ["a", ref.coordinate, ref.relayHint, ref.viewKey, ref.role];
}

export function parseBoardRef(tag: string[]): BoardListRef | null {
  if (tag[0] !== "a" || !tag[1]) return null;
  const role = tag[4] as BoardRole | undefined;
  return {
    coordinate: tag[1],
    relayHint: tag[2] ?? "",
    viewKey: tag[3] ?? "",
    // Least privilege on anything unrecognised: a forged "owner" must not become
    // one just by claiming it. The board's own maintainer set decides.
    role: role && ROLES.includes(role) ? role : "member",
  };
}

export function encodeBoardList(list: KanbanBoardList): string[][] {
  return [["title", list.title], ...list.boards.map(buildBoardRef)];
}

export function decodeBoardList(tags: string[][], dTag: string, eventId: string): KanbanBoardList {
  let title = DEFAULT_BOARD_LIST_TITLE;
  const boards: BoardListRef[] = [];

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length === 0) continue;
    if (tag[0] === "title") {
      title = tag[1] ?? title;
      continue;
    }
    // One malformed row must not cost the user every other board in the list.
    const ref = parseBoardRef(tag);
    if (ref) boards.push(ref);
  }

  return { id: dTag, eventId, title, boards, createdAt: 0 };
}
