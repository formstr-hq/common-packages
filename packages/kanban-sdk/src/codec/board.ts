import type { Event } from "nostr-tools";

import { KANBAN_KINDS } from "../kinds";
import type { BoardDraft, Column, KanbanBoard } from "../types";

/**
 * Tags this codec owns. `mergeTags` replaces exactly these and leaves everything
 * else alone, so an edit cannot silently drop a tag the model does not know about
 * — which is how kanbanstr loses `nozap` on every board update
 * (kanban/docs/03-kanbanstr-review.md §6.3).
 */
export const BOARD_MANAGED_TAGS = ["d", "title", "description", "alt", "col", "p", "nozap"] as const;

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
  for (const maintainer of new Set(draft.maintainers ?? [])) {
    tags.push(["p", maintainer]);
  }
  if (draft.noZap) tags.push(["nozap"]);

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
    maintainers: event.tags.filter((t) => t[0] === "p").map((t) => t[1]),
    members: [],
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
  "member",
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
  // Deduplicated, and a maintainer never also appears as a member: two rows for
  // one pubkey are two conflicting roles, and which one a reader believes then
  // depends on tag order.
  const maintainers = new Set(draft.maintainers ?? []);
  for (const maintainer of maintainers) {
    tags.push(["maintainer", maintainer]);
  }
  for (const member of new Set(draft.members ?? [])) {
    if (maintainers.has(member)) continue;
    tags.push(["member", member]);
  }
  if (draft.noZap) tags.push(["nozap"]);

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
    maintainers: innerTags.filter((t) => t[0] === "maintainer").map((t) => t[1]),
    members: innerTags.filter((t) => t[0] === "member").map((t) => t[1]),
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
