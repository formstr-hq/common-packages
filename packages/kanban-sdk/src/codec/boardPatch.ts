import type { Event } from "nostr-tools";

import type { Column } from "../types";

/**
 * An admin's delta against a board they do not own.
 *
 * A board event is addressable at `kind:pubkey:d`, so only its creator can
 * publish a new version of it (doc 05 §7). An admin writes one of these
 * instead, at their own coordinate, and every reader folds it over the base.
 */
export interface BoardPatch {
  /** Who signed it. Only the base board decides whether that key counts. */
  author: string;
  /** `<creatorPubkey>:<boardDTag>` on a public board, the blinded pointer on a private one. */
  boardRef: string;
  createdAt: number;
  /** Undefined when this patch does not touch the field. Empty string clears it. */
  title?: string;
  description?: string;
  columns: Column[];
  columnsRemoved: string[];
  participantsAdded: string[];
  participantsRemoved: string[];
}

export interface BoardPatchDraft {
  title?: string;
  description?: string;
  columns?: Column[];
  columnsRemoved?: string[];
  participantsAdded?: string[];
  participantsRemoved?: string[];
}

/**
 * Tags this codec owns, for the same merge contract the board codec uses: an
 * edit replaces exactly these and leaves any tag written by a newer client alone.
 */
export const PATCH_MANAGED_TAGS = [
  "d",
  "title",
  "description",
  "col",
  "col-removed",
  "maintainer",
  "maintainer-removed",
] as const;

export function buildPatchTags(draft: BoardPatchDraft, boardRef: string): string[][] {
  const tags: string[][] = [["d", boardRef]];

  // Presence, not truthiness: an empty string is a real value that clears the
  // field, and skipping it would silently turn "clear the description" into
  // "leave it as it was".
  if (draft.title !== undefined) tags.push(["title", draft.title]);
  if (draft.description !== undefined) tags.push(["description", draft.description]);

  for (const column of draft.columns ?? []) {
    tags.push(["col", column.id, column.name, String(column.order)]);
  }
  for (const id of new Set(draft.columnsRemoved ?? [])) {
    tags.push(["col-removed", id]);
  }
  for (const pubkey of new Set(draft.participantsAdded ?? [])) {
    tags.push(["maintainer", pubkey]);
  }
  for (const pubkey of new Set(draft.participantsRemoved ?? [])) {
    tags.push(["maintainer-removed", pubkey]);
  }

  return tags;
}

/**
 * Parse a patch. `innerTags` is the decrypted payload on a private board; omit
 * it and the event's own tags are read instead.
 *
 * Deliberately blind to `admin` rows. A patch that could grant admin would let
 * any admin promote a peer, or promote themselves past the creator, so the
 * escalation guard starts here rather than in the fold.
 */
export function parsePatch(event: Event, innerTags?: string[][]): BoardPatch | null {
  const tags = innerTags ?? event.tags;
  const boardRef = tags.find((t) => t[0] === "d")?.[1];
  if (!boardRef) return null;

  // The payload repeats `d` so it is self-describing once decrypted. Disagreeing
  // with the wrapper means a key holder has cross-posted one board's patch under
  // another board's pointer.
  if (innerTags) {
    const outer = event.tags.find((t) => t[0] === "d")?.[1];
    if (outer !== boardRef) return null;
  }

  const columns: Column[] = tags
    .filter((t) => t[0] === "col" && t[1])
    .map((t) => {
      const order = Number.parseInt(t[3] ?? "0", 10);
      return { id: t[1], name: t[2] ?? "", order: Number.isFinite(order) ? order : 0 };
    });

  const values = (name: string): string[] => [
    ...new Set(tags.filter((t) => t[0] === name && t[1]).map((t) => t[1])),
  ];

  return {
    author: event.pubkey,
    boardRef,
    createdAt: event.created_at,
    title: tags.find((t) => t[0] === "title")?.[1],
    description: tags.find((t) => t[0] === "description")?.[1],
    columns,
    columnsRemoved: values("col-removed"),
    participantsAdded: values("maintainer"),
    participantsRemoved: values("maintainer-removed"),
  };
}
