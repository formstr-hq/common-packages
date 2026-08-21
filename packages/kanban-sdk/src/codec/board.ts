import type { Event } from "nostr-tools";

import { KANBAN_KINDS } from "../kinds";
import type { BoardDraft, Column, KanbanBoard } from "../types";

/**
 * Tags this codec owns. `mergeTags` replaces exactly these and leaves everything
 * else alone, so an edit cannot silently drop a tag the model does not know about
 * — which is how kanbanstr loses `nozap` on every board update
 * (kanban/docs/03-kanbanstr-review.md §6.3).
 */
export const BOARD_MANAGED_TAGS = [
  "d",
  "title",
  "description",
  "alt",
  "col",
  "p",
  "admin",
  "baked",
  "nozap",
] as const;

/**
 * Everyone with card-write access, admins first and nobody twice.
 *
 * An admin is p-tagged as well as admin-tagged: kanbanstr reads `p` as
 * maintainer, so tagging admins only as `admin` would lock them out of card
 * writes in every client that has not learned the role.
 */
function writers(draft: BoardDraft): { admins: string[]; everyone: string[] } {
  const admins = [...new Set(draft.admins ?? [])];
  const adminSet = new Set(admins);
  const participants = [...new Set(draft.participants ?? [])].filter((p) => !adminSet.has(p));
  return { admins, everyone: [...admins, ...participants] };
}

export function boardCoordinate(
  board: Pick<KanbanBoard, "pubkey" | "id"> & { isPrivate?: boolean },
): string {
  const kind = board.isPrivate ? KANBAN_KINDS.privateBoard : KANBAN_KINDS.publicBoard;
  return `${kind}:${board.pubkey}:${board.id}`;
}

export function buildPublicBoardTags(draft: BoardDraft, dTag: string): string[][] {
  const tags: string[][] = [
    ["d", dTag],
    ["title", draft.title],
    ["description", draft.description ?? ""],
    ["alt", `A board titled ${draft.title}`],
  ];

  for (const column of draft.columns) {
    tags.push(["col", column.id, column.name, String(column.order)]);
  }
  // Deduplicated: callers build the roster by appending to the parsed list, so a
  // re-invite would otherwise leave the same pubkey tagged twice.
  const { admins, everyone } = writers(draft);
  for (const admin of admins) tags.push(["admin", admin]);
  for (const writer of everyone) tags.push(["p", writer]);

  if (draft.noZap) tags.push(["nozap"]);
  if (draft.baked) tags.push(["baked", String(draft.baked)]);

  return tags;
}

/**
 * v0 boards kept columns and description in stringified JSON `content` and listed
 * their cards with board-side `a` tags. They still exist on relays; we read them
 * but never write them.
 */
export function isLegacyBoard(event: Event): boolean {
  if (event.tags.some((t) => t[0] === "a")) return true;
  if (!event.content) return false;
  try {
    const parsed = JSON.parse(event.content) as { columns?: unknown };
    return Array.isArray(parsed.columns);
  } catch {
    return false;
  }
}

/**
 * Admins, participants and legacy viewers as three disjoint lists.
 *
 * An admin is tagged twice on the wire (`admin` plus `p`/`maintainer`), so the
 * writer list has to have the admins subtracted from it or every roster shows
 * them once per role.
 */
function splitRoles(
  adminTags: string[],
  writerTags: string[],
  memberTags: string[],
): Pick<KanbanBoard, "admins" | "participants" | "legacyViewers"> {
  const admins = [...new Set(adminTags)];
  const adminSet = new Set(admins);
  const participants = [...new Set(writerTags)].filter((p) => !adminSet.has(p));
  const claimed = new Set([...admins, ...participants]);
  return {
    admins,
    participants,
    legacyViewers: [...new Set(memberTags)].filter((p) => !claimed.has(p)),
  };
}

/** Zero for a board that has never been baked, or whose watermark is unreadable. */
function parseBaked(tags: string[][]): number {
  const raw = tags.find((t) => t[0] === "baked")?.[1];
  const parsed = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * The board exactly as its creator wrote it, with no patches folded in.
 *
 * `rawTags` is the creator's own tag array (the decrypted payload on a private
 * board), so this recovers the base state from a board object that has already
 * been folded. The creator's own edits have to start from here: folding over an
 * already-folded board cannot un-apply a patch, so baking would silently adopt
 * the pending changes of an admin being demoted in that same save.
 */
export function baseState(
  tags: string[][],
  isPrivate: boolean,
): Pick<
  KanbanBoard,
  "title" | "description" | "columns" | "admins" | "participants" | "legacyViewers" | "baked"
> {
  const writerTag = isPrivate ? "maintainer" : "p";
  return {
    title: tags.find((t) => t[0] === "title")?.[1] ?? "Untitled Board",
    description: tags.find((t) => t[0] === "description")?.[1] ?? "",
    columns: tags
      .filter((t) => t[0] === "col")
      .map((t) => ({ id: t[1], name: t[2], order: Number.parseInt(t[3] ?? "0", 10) }))
      .sort((a, b) => a.order - b.order),
    ...splitRoles(
      tags.filter((t) => t[0] === "admin").map((t) => t[1]),
      tags.filter((t) => t[0] === writerTag).map((t) => t[1]),
      isPrivate ? tags.filter((t) => t[0] === "member").map((t) => t[1]) : [],
    ),
    baked: parseBaked(tags),
  };
}

export function parsePublicBoard(event: Event): KanbanBoard | null {
  const id = event.tags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;

  const legacy = isLegacyBoard(event);
  let columns: Column[] = [];
  let description = event.tags.find((t) => t[0] === "description")?.[1] ?? "";

  if (legacy) {
    try {
      const parsed = JSON.parse(event.content) as {
        columns?: Column[];
        description?: string;
      };
      columns = parsed.columns ?? [];
      description = parsed.description ?? description;
    } catch {
      columns = [];
    }
  } else {
    columns = event.tags
      .filter((t) => t[0] === "col")
      .map((t) => ({ id: t[1], name: t[2], order: Number.parseInt(t[3] ?? "0", 10) }));
  }

  columns = [...columns].sort((a, b) => a.order - b.order);

  return {
    id,
    pubkey: event.pubkey,
    eventId: event.id,
    title: event.tags.find((t) => t[0] === "title")?.[1] ?? "Untitled Board",
    description,
    columns,
    ...splitRoles(
      event.tags.filter((t) => t[0] === "admin").map((t) => t[1]),
      event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
      [],
    ),
    baked: parseBaked(event.tags),
    noZap: event.tags.some((t) => t[0] === "nozap"),
    createdAt: event.created_at,
    isPrivate: false,
    legacy,
    rawTags: event.tags,
  };
}

/**
 * Inner tags this codec owns. Same merge contract as the public path, applied to
 * the DECRYPTED payload: an edit replaces exactly these and leaves every other
 * inner tag alone, so a tag written by a newer client survives our round trip.
 */
export const PRIVATE_BOARD_MANAGED_TAGS = [
  "d",
  "title",
  "description",
  "col",
  "maintainer",
  "admin",
  "member",
  "baked",
  "nozap",
] as const;

/** The inner tag array of a private board, to be NIP-44'd under the view key. */
export function buildPrivateBoardTags(draft: BoardDraft, dTag: string): string[][] {
  // No `alt`: NIP-31's plaintext summary would restate exactly what is encrypted.
  const tags: string[][] = [
    ["d", dTag],
    ["title", draft.title],
    ["description", draft.description ?? ""],
  ];

  for (const column of draft.columns) {
    tags.push(["col", column.id, column.name, String(column.order)]);
  }
  // Deduplicated, and an admin never also appears as a plain maintainer row's
  // only mention: two rows for one pubkey are two conflicting roles, and which
  // one a reader believes would otherwise depend on tag order.
  const { admins, everyone } = writers(draft);
  for (const admin of admins) tags.push(["admin", admin]);
  for (const writer of everyone) tags.push(["maintainer", writer]);

  // Re-emitted, never added to. Dropping them would erase the record of who
  // still holds a key to a board that has not been rotated.
  const writerSet = new Set(everyone);
  for (const viewer of new Set(draft.legacyViewers ?? [])) {
    if (writerSet.has(viewer)) continue;
    tags.push(["member", viewer]);
  }

  if (draft.noZap) tags.push(["nozap"]);
  if (draft.baked) tags.push(["baked", String(draft.baked)]);

  return tags;
}

/**
 * Parse a decrypted private board. `innerTags` is the JSON-parsed plaintext;
 * `event` supplies the identity fields the payload cannot be trusted for.
 */
export function parsePrivateBoard(event: Event, innerTags: string[][]): KanbanBoard | null {
  const id = innerTags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;

  // The payload repeats `d` so it is self-describing after decryption. If the
  // two disagree, a key holder has cross-posted one board's payload under
  // another board's coordinate — discard rather than resolve in their favour.
  const outerDTag = event.tags.find((t) => t[0] === "d")?.[1];
  if (outerDTag !== id) return null;

  const columns: Column[] = innerTags
    .filter((t) => t[0] === "col")
    .map((t) => ({ id: t[1], name: t[2], order: Number.parseInt(t[3] ?? "0", 10) }))
    .sort((a, b) => a.order - b.order);

  return {
    id,
    pubkey: event.pubkey,
    eventId: event.id,
    title: innerTags.find((t) => t[0] === "title")?.[1] ?? "Untitled Board",
    description: innerTags.find((t) => t[0] === "description")?.[1] ?? "",
    columns,
    ...splitRoles(
      innerTags.filter((t) => t[0] === "admin").map((t) => t[1]),
      innerTags.filter((t) => t[0] === "maintainer").map((t) => t[1]),
      innerTags.filter((t) => t[0] === "member").map((t) => t[1]),
    ),
    baked: parseBaked(innerTags),
    noZap: innerTags.some((t) => t[0] === "nozap"),
    createdAt: event.created_at,
    isPrivate: true,
    legacy: false,
    // rawTags holds the INNER tags for private boards: that is what an edit merges into.
    rawTags: innerTags,
  };
}

/**
 * Merge freshly built tags into an existing tag array, replacing only the managed
 * names. Unknown tags survive the round trip.
 */
export function mergeTags(
  existing: string[][],
  next: string[][],
  managed: readonly string[],
): string[][] {
  const managedSet = new Set(managed);
  const preserved = existing.filter((tag) => !managedSet.has(tag[0]));
  return [...next, ...preserved];
}

/**
 * Stamp the first author onto a card or comment payload somebody else is about
 * to re-sign.
 *
 * Both are author-signed at `kind:pubkey:d`, so a second maintainer's edit is a
 * new coordinate sharing the `d`, not a new version of the same event. Without
 * this the edit silently transfers authorship to whoever saved last — and with
 * it, the right to delete.
 *
 * An author already recorded is preserved: only the FIRST writer is the author,
 * and a third editor must not overwrite them with the second.
 */
export function withOriginalAuthor(tags: string[][], originalAuthor: string): string[][] {
  if (tags.some((t) => t[0] === "original-author")) return tags;
  return [...tags, ["original-author", originalAuthor]];
}
