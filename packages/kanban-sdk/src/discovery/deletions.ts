import type { Event } from "nostr-tools";

export interface DeletedSet {
  ids: Set<string>;
  coordinates: Set<string>;
}

/** Index kind-5 events by what they claim to delete (NIP-09 `e` and `a` tags). */
export function collectDeleted(deletionEvents: Event[]): DeletedSet {
  const ids = new Set<string>();
  const coordinates = new Set<string>();
  for (const event of deletionEvents) {
    for (const tag of event.tags) {
      if (tag[0] === "e" && tag[1]) ids.add(tag[1]);
      if (tag[0] === "a" && tag[1]) coordinates.add(tag[1]);
    }
  }
  return { ids, coordinates };
}

/**
 * Relays honour NIP-09 inconsistently, and addressable events keep resolving
 * after deletion, so every fetch path filters client-side.
 */
export function isDeleted(
  event: Event,
  deleted: DeletedSet,
  coordinateOf: (event: Event) => string,
): boolean {
  if (deleted.ids.has(event.id)) return true;
  return deleted.coordinates.has(coordinateOf(event));
}
