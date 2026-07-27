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

export function boardCoordinate(board: Pick<KanbanBoard, "pubkey" | "id">): string {
  return `${KANBAN_KINDS.publicBoard}:${board.pubkey}:${board.id}`;
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
  for (const maintainer of draft.maintainers ?? []) {
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
    noZap: event.tags.some((t) => t[0] === "nozap"),
    createdAt: event.created_at,
    isPrivate: false,
    legacy,
    rawTags: event.tags,
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
