/**
 * DataLayer — the intent-only surface the UI talks to. It replaces `nostrRuntime`.
 *
 * Load-bearing invariant: the app can only DECLARE INTERESTS (`observe` /
 * `observeOnce`, and the `useEvents`/`useEvent` hooks built on them) and PUBLISH.
 * There is no `fetch`/`sync`/`reconnect`/`resetRelays` — nothing here can cause
 * the worker to open a connection on demand. The worker owns every connection
 * decision from the union of active interests, so presentation scales
 * independently of the network.
 *
 * Dependency-injected (client + sign), so it's testable in jsdom over an
 * in-memory channel. Browser wiring lives in `bootstrap.ts`.
 */
import type { Event, Filter } from "../localRelay/core/types";
import type { EventTemplate } from "nostr-tools";
import { LocalRelayClient, SubscribeHandlers } from "../localRelay/transport/LocalRelayClient";
import type { RelayPublishOutcome, RelayHealth, Diagnostics } from "../localRelay/transport/frames";

export type { RelayPublishOutcome, RelayHealth, Diagnostics };

/**
 * Aggregate publish outcome — same shape `PublishDiagnosticModal` already
 * consumes (per-relay accepted/rejected/timeout/failed + a summary), so the
 * diagnostics UI works unchanged.
 */
export interface PublishResult {
  ok: boolean;
  accepted: number;
  total: number;
  relayResults: RelayPublishOutcome[];
}

function toPublishResult(relayResults: RelayPublishOutcome[]): PublishResult {
  const accepted = relayResults.filter((r) => r.status === "accepted").length;
  return { ok: accepted > 0, accepted, total: relayResults.length, relayResults };
}

export interface DataLayerDeps {
  client: LocalRelayClient;
  /** Sign a template into a full event (local/NIP-07/NIP-46 via signerManager). */
  sign: (template: EventTemplate) => Promise<Event>;
}

export interface ObserveOptions {
  /** Pure store read — no network. The worker syncs upstream when false (default). */
  localOnly?: boolean;
}

export interface ObserveHandle {
  id: string;
  /** Re-declare this interest with new filters (e.g. a wider window for paging). */
  update: (filters: Filter[]) => void;
  unobserve: () => void;
}

export class DataLayer {
  constructor(private deps: DataLayerDeps) {}

  /**
   * Declare a standing interest: cache replay → EOSE → live tail via `handlers`,
   * and (unless `localOnly`) the worker autonomously keeps the scope warm. This
   * is the imperative form of `useEvents`, for non-React code (contexts). It does
   * NOT command a fetch — it states what the app cares about; the worker decides
   * the network. `update` re-declares with a wider window to paginate.
   */
  observe(filters: Filter[], handlers: SubscribeHandlers, options: ObserveOptions = {}): ObserveHandle {
    return this.deps.client.observe(filters, handlers, options);
  }

  /**
   * Resolve a single event by id from the CACHE — never triggers a fetch. A read
   * cannot cause network activity; the worker keeps the store populated (incl.
   * enriching referenced events for scopes it syncs). Resolves the cached event
   * or `null`. The reactive twin `useEvent` also updates if enrichment lands later.
   */
  fetchById(id: string): Promise<Event | null> {
    return this.resolveOne([{ ids: [id], limit: 1 }]);
  }

  /** Current value of a REPLACEABLE event (profile/relay-list) from cache. No fetch. */
  fetchReplaceable(kind: number, pubkey: string): Promise<Event | null> {
    return this.resolveOne([{ kinds: [kind], authors: [pubkey], limit: 1 }]);
  }

  /** Cache-only single-value resolve: replay matches, resolve on the local EOSE. */
  private resolveOne(filters: Filter[]): Promise<Event | null> {
    return new Promise((resolve) => {
      let found: Event | null = null;
      const handle = this.deps.client.observe(
        filters,
        {
          onEvent: (e) => {
            found = e;
          },
          onEose: () => {
            handle.unobserve();
            resolve(found);
          },
        },
        { localOnly: true }
      );
    });
  }

  /**
   * Sign a template, store it locally (so local interests see it instantly), and
   * send it upstream — the one mutation entry point. Returns the signed event plus
   * the per-relay publish outcome that feeds the diagnostics modal. Retry is just
   * another `publishEvent` — the worker, not the app, reaches dead relays.
   */
  async publish(template: EventTemplate): Promise<{ event: Event; result: PublishResult }> {
    const event = await this.deps.sign(template);
    const outcomes = await this.deps.client.publish(event);
    return { event, result: toPublishResult(outcomes) };
  }

  /** Publish an already-signed event (used by nip17/lists + diagnostics retry). */
  async publishEvent(event: Event): Promise<PublishResult> {
    return toPublishResult(await this.deps.client.publish(event));
  }

  /** Add an event to the local store (optimistic / received out-of-band). No network. */
  addEvent(event: Event): void {
    this.deps.client.ingest([event]);
  }

  /** Batch-add events to the local store. No network. */
  addEvents(events: Event[]): void {
    this.deps.client.ingest(events);
  }

  /** Live connection health of the user's relays (read-only observation). */
  relayHealth(): Promise<RelayHealth[]> {
    return this.deps.client.relayHealth();
  }

  /**
   * Relays a cached event was opportunistically observed on — received upstream
   * on an already-open subscription, or accepted on publish. Read-only; never
   * triggers a fetch. NOT an inventory of who has the event: the worker never
   * re-fetches what it already holds and the pool dedups per subscription, so
   * this is usually ONE relay (the source). Good for deriving a relay hint, not
   * for "on N relays" counts. Empty if not stored or no source was recorded.
   */
  seenOn(eventId: string): Promise<string[]> {
    return this.deps.client.seenOn(eventId);
  }

  /**
   * Read-only snapshot of the worker's state — paused flag, declared interests,
   * live upstream subscriptions + their routed relays, relay health, store stats,
   * and pending enrichment. For debugging only; triggers no network.
   */
  diagnostics(): Promise<Diagnostics> {
    return this.deps.client.diagnostics();
  }

  /** Active-account change: retarget scope (does NOT rehydrate the shared store). */
  setActiveAccount(pubkey: string | null): void {
    this.deps.client.setActiveAccount(pubkey);
  }

  /** Relays the user reads from — a routing-policy input, not a command. */
  setUserRelays(relays: string[]): void {
    this.deps.client.setUserRelays(relays);
  }

  /**
   * The user's NIP-17 DM inbox relays (kind 10050) — where their gift-wrapped DMs
   * are delivered. The worker reads the kind-1059 stream from these specifically;
   * general feed reads stay off them. Routing-policy input, not a command.
   */
  setDmRelays(relays: string[]): void {
    this.deps.client.setDmRelays(relays);
  }

  /**
   * Add a discovered relay to the gossip pool so the worker can fetch
   * referenced/missing events from it (e.g. a note referenced inside a DM, whose
   * relay hint only the client can see after decryption). Read/discovery only —
   * never a publish target, kept separate from the user's own relays, and bounded.
   */
  addGossipRelay(url: string): void {
    this.deps.client.addGossipRelay(url);
  }

  /** Remove a relay from the gossip pool; future fetches stop targeting it. */
  removeGossipRelay(url: string): void {
    this.deps.client.removeGossipRelay(url);
  }

  /** App backgrounded — lifecycle hint; the worker decides what to do. */
  pause(): void {
    this.deps.client.pause();
  }

  /** App foregrounded. */
  resume(): void {
    this.deps.client.resume();
  }
}

// ---- singleton accessor (bootstrap.ts sets it; the hooks read it) ----
let instance: DataLayer | null = null;

/** Install the process-wide DataLayer (browser bootstrap, or a fake in tests). */
export function setDataLayer(dl: DataLayer | null): void {
  instance = dl;
}

/** The bootstrapped DataLayer. Throws if accessed before bootstrap. */
export function getDataLayer(): DataLayer {
  if (!instance) {
    throw new Error("DataLayer not bootstrapped — call bootstrapDataLayer() at app start.");
  }
  return instance;
}

/**
 * Ambient handle for non-React code (contexts, helpers, nip17). Resolves the
 * bootstrapped singleton lazily per call, so `import { dataLayer }` works at
 * module scope. React components should prefer the hooks.
 */
export const dataLayer: DataLayer = new Proxy({} as DataLayer, {
  get(_target, prop) {
    const dl = getDataLayer();
    const value = (dl as unknown as Record<string | symbol, unknown>)[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(dl) : value;
  },
});
