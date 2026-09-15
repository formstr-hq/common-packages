import type { Event } from "nostr-tools";

export interface DeletedSet {
  /**
   * What each author has tombstoned, keyed by the author of the kind-5 itself.
   *
   * Keyed rather than flattened because NIP-09 only lets an event's own author
   * delete it. Every fetch path queries deletions from a whole set of authors —
   * a board's maintainers, or every author in a result — so a flat set would let
   * one maintainer's tombstone erase another's card.
   */
  byAuthor: Map<string, { ids: Set<string>; coordinates: Set<string> }>;
}

/** Index kind-5 events by their author and by what they claim to delete. */
export function collectDeleted(deletionEvents: Event[]): DeletedSet {
  const byAuthor = new Map<string, { ids: Set<string>; coordinates: Set<string> }>();
  for (const event of deletionEvents) {
    let own = byAuthor.get(event.pubkey);
    if (!own) {
      own = { ids: new Set<string>(), coordinates: new Set<string>() };
      byAuthor.set(event.pubkey, own);
    }
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) own.ids.add(tag[1]);
      if (tag[0] === "a" && tag[1]) own.coordinates.add(tag[1]);
    }
  }
  return { byAuthor };
}

/**
 * Relays honour NIP-09 inconsistently, and addressable events keep resolving
 * after deletion, so every fetch path filters client-side.
 *
 * Only the event's own author can delete it: a tombstone signed by anyone else
 * is not a deletion request the protocol recognises, and honouring one would let
 * any maintainer erase any other's work. Omit `coordinateOf` for events that
 * have no addressable coordinate, such as gift wraps.
 */
export function isDeleted(
  event: Event,
  deleted: DeletedSet,
  coordinateOf?: (event: Event) => string,
): boolean {
  const own = deleted.byAuthor.get(event.pubkey);
  if (!own) return false;
  if (own.ids.has(event.id)) return true;
  return coordinateOf !== undefined && own.coordinates.has(coordinateOf(event));
}
