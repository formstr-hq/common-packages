import type { Event } from "nostr-tools";

import { coordinate } from "../codec/identifiers";

/**
 * NIP-01 replaceable-event resolution — docs/protocol.md §11.
 *
 * Relays hand back several versions of one addressable coordinate during
 * backfill, in no particular order. Taking whichever arrived last is how an
 * edit gets silently reverted, or a busy block reappears after it was removed.
 */

/**
 * Does `candidate` supersede `incumbent`? Higher `created_at` wins; on a tie
 * the **lower event id** wins, which is NIP-01's rule and the reason every
 * republish in this SDK uses `nextCreatedAt`.
 */
export function supersedes(candidate: Event, incumbent: Event | undefined): boolean {
  if (!incumbent) return true;
  if (candidate.created_at !== incumbent.created_at) {
    return candidate.created_at > incumbent.created_at;
  }
  return candidate.id < incumbent.id;
}

function dTagOf(event: Event): string {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

/** The winning version of each `kind:pubkey:d` coordinate. */
export function newestByCoordinate(events: readonly Event[]): Map<string, Event> {
  const winners = new Map<string, Event>();
  for (const event of events) {
    const key = coordinate(event.kind, event.pubkey, dTagOf(event));
    if (supersedes(event, winners.get(key))) winners.set(key, event);
  }
  return winners;
}

/** The winning version of each d-tag, for a set already scoped to one author. */
export function newestByDTag(events: readonly Event[]): Map<string, Event> {
  const winners = new Map<string, Event>();
  for (const event of events) {
    const key = dTagOf(event);
    if (supersedes(event, winners.get(key))) winners.set(key, event);
  }
  return winners;
}

/** One event per id, keeping the first seen. */
export function dedupeById(events: readonly Event[]): Event[] {
  const seen = new Map<string, Event>();
  for (const event of events) {
    if (!seen.has(event.id)) seen.set(event.id, event);
  }
  return [...seen.values()];
}
