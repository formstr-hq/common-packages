/**
 * `@formstr/drive-sdk/local-relay` — a tiny adapter for hosts that already run `@formstr/local-relay`.
 *
 * Not needed to use the SDK: `createRelayPoolStore` (main entry) is the self-contained default and works
 * on plain Node and in browsers with no worker. This entry only helps a host that already owns a local-relay
 * `dataLayer` hand it over, type-checked against its (>=0.6) shape, and keeps a class-based DataLayer's
 * `this`. It imports nothing from local-relay — the types below are structural — so there is no package
 * dependency, optional or otherwise.
 *
 * ```ts
 * import { dataLayer } from "@formstr/local-relay";
 * import { localRelayStore } from "@formstr/drive-sdk/local-relay";
 *
 * const store = localRelayStore(dataLayer);
 * ```
 */
import type { Event, Filter } from "nostr-tools";
import type { FileEventStore, FilePublishResult } from "./types.js";

/** The slice of local-relay's `DataLayer` this package uses — structural, so no import. */
export interface LocalRelayDataLayer {
  observe(
    filters: Filter[],
    handlers: { onEvent: (event: Event) => void; onEose?: () => void },
    options?: { localOnly?: boolean; relays?: string[] },
  ): { unobserve: () => void };
  publishEvent(event: Event, options?: { relays?: string[] }): Promise<FilePublishResult>;
  seenOn?(eventId: string): Promise<string[]>;
}

export function localRelayStore(dataLayer: LocalRelayDataLayer): FileEventStore {
  const store: FileEventStore = {
    observe: (filters, handlers, options) => dataLayer.observe(filters, handlers, options),
    publishEvent: (event, options) => dataLayer.publishEvent(event, options),
  };
  if (dataLayer.seenOn) store.seenOn = (eventId) => dataLayer.seenOn!(eventId);
  return store;
}
