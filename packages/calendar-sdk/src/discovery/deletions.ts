import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import type { NostrRuntime } from "../contracts";

/**
 * Deletion index — docs/protocol.md §11.
 *
 * Relays are not required to enforce NIP-09, and in practice most enforce it
 * only by `e` tag, while addressable events are deleted by `a` coordinate. So a
 * client that wants a deleted event to stay deleted has to filter locally.
 */

export interface DeletionIndex {
  /** Deleted event ids, from `e` rows. */
  ids: Set<string>;
  /** Deleted addressable coordinates, from `a` rows. */
  coordinates: Set<string>;
}

export function emptyDeletionIndex(): DeletionIndex {
  return { ids: new Set(), coordinates: new Set() };
}

/** Folds kind-5 deletion requests into an index. */
export function indexDeletions(events: readonly Event[]): DeletionIndex {
  const index = emptyDeletionIndex();
  for (const event of events) {
    if (event.kind !== CALENDAR_KINDS.deletion) continue;
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) index.ids.add(tag[1]);
      if (tag[0] === "a" && tag[1]) index.coordinates.add(tag[1]);
    }
  }
  return index;
}

/**
 * The caller's own deletions.
 *
 * Scope is deliberately self-authored only, matching upstream: a kind-5 from
 * anyone else is not authoritative over your view, and honouring third-party
 * deletions would let a stranger hide events from you.
 */
export async function fetchDeletions(
  runtime: NostrRuntime,
  relays: string[],
  pubkey: string,
  timeoutMs?: number,
): Promise<DeletionIndex> {
  const events = await runtime.querySync(
    relays,
    { kinds: [CALENDAR_KINDS.deletion], authors: [pubkey] },
    timeoutMs,
  );
  return indexDeletions(events);
}

export function isDeleted(
  index: DeletionIndex,
  target: { id?: string; coordinate?: string },
): boolean {
  if (target.id && index.ids.has(target.id)) return true;
  if (target.coordinate && index.coordinates.has(target.coordinate)) return true;
  return false;
}

/**
 * Deletion-request tags — `e` per id, `a` per coordinate, `k` per kind.
 * NIP-09 wants the `k` rows so a relay can validate the request without
 * fetching the targets.
 */
export function buildDeletionTags(params: {
  eventIds?: readonly string[];
  coordinates?: readonly string[];
  kinds?: readonly number[];
}): string[][] {
  const tags: string[][] = [];
  for (const id of params.eventIds ?? []) tags.push(["e", id]);
  for (const coord of params.coordinates ?? []) tags.push(["a", coord]);
  for (const kind of params.kinds ?? []) tags.push(["k", String(kind)]);
  return tags;
}
