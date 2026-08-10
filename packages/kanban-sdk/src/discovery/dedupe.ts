import type { Event } from "nostr-tools";

/**
 * NIP-01 replaceable-event resolution. From 01.md:101 — "In case of replaceable
 * events with the same timestamp, the event with the lowest id (first in lexical
 * order) should be retained, and the other discarded."
 *
 * Relays apply exactly this. A client that ties any other way (e.g. keep-first,
 * which depends on relay response order) can disagree with the relay about which
 * version is current.
 */
export function supersedes(candidate: Event, incumbent: Event): boolean {
  if (candidate.created_at !== incumbent.created_at) {
    return candidate.created_at > incumbent.created_at;
  }
  return candidate.id < incumbent.id;
}

/** Resolve many versions of addressable events to the current one per `d` tag. */
export function newestByDTag(events: Iterable<Event>): Map<string, Event> {
  const newest = new Map<string, Event>();
  for (const event of events) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const previous = newest.get(dTag);
    if (!previous || supersedes(event, previous)) newest.set(dTag, event);
  }
  return newest;
}

/**
 * Strict supersession. Two writes inside the same second otherwise TIE, and the
 * NIP-01 tie-break can keep the stale version — silently losing an entire edit.
 */
export function nextCreatedAt(previousCreatedAt?: number): number {
  const now = Math.floor(Date.now() / 1000);
  if (previousCreatedAt === undefined) return now;
  return Math.max(now, previousCreatedAt + 1);
}
