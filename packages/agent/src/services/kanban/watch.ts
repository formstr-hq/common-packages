import { nostrRuntime } from "@formstr/core";
import { KANBAN_KINDS } from "@formstr/kanban-sdk";
import type { Event, Filter } from "nostr-tools";

import { kanbanRelays } from "./sdk";

/**
 * Public cards assigned to `pubkey` carry `["p", pubkey]` (kanbanstr writes it
 * alongside `["zap", …]`), so a single filter finds every new assignment across
 * every board without knowing which boards exist. The watcher for "work picked
 * up for me" is built on this.
 */
export function assignedCardsFilter(pubkey: string): Filter {
  return { kinds: [KANBAN_KINDS.publicCard], "#p": [pubkey] };
}

/**
 * Subscribe to public cards assigned to `pubkey`. Returns the handle; call
 * `unsub()` to stop. Private assignments are invisible here — a public-card
 * event carries no board key — so a host that also watches private boards polls
 * `openAssignments()` alongside this stream.
 */
export function subscribeAssignedCards(
  pubkey: string,
  onEvent: (event: Event) => void,
): { unsub(): void } {
  return nostrRuntime.subscribe(kanbanRelays(), [assignedCardsFilter(pubkey)], { onEvent });
}
