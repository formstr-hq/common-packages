import { matchFilter, type Event, type Filter } from "nostr-tools";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import { normalizeURL } from "nostr-tools/utils";
import type { FileEventStore, FilePublishResult, FileRelayOutcome } from "./types.js";

// The self-contained FileEventStore: plain websockets through nostr-tools' SimplePool, nothing else.
// It exists so the SDK runs anywhere nostr-tools does — a browser, a Node server, an agent — with no
// Web Worker, no IndexedDB and no @formstr/local-relay. Hosts that already own a data layer (or a pool)
// keep using it: FileEventStore is three methods, and this is just the batteries-included default.

/** The slice of nostr-tools' SimplePool this store uses. Inject your own to share a pool, or to test. */
export interface RelayPoolLike {
  subscribeMany(
    relays: string[],
    filter: Filter,
    params: { onevent(event: Event): void; oneose?(): void; onclose?(reasons: string[]): void; maxWait?: number },
  ): { close(reason?: string): void };
  publish(relays: string[], event: Event, params?: { maxWait?: number }): Promise<string>[];
  close(relays: string[]): void;
  /** Only populated when `trackRelays` is true; the store turns it on. */
  seenOn?: Map<string, Set<{ url: string }>>;
  trackRelays?: boolean;
}

export interface RelayPoolStoreOptions {
  /** Relays every read and publish goes to. Per-call `relays` hints are added to these, never replace them. */
  relays: readonly string[];
  /** Share an existing pool, or inject a fake. Default: a new `SimplePool`. */
  pool?: RelayPoolLike;
  /**
   * A WebSocket constructor, e.g. the `ws` package. Needed on Node 20, which has no global WebSocket;
   * Node 22+ and browsers do not need it. NOTE: nostr-tools keeps this PROCESS-wide, not per store.
   */
  webSocket?: unknown;
  /** How long a read waits for slow relays before reporting end-of-stored-events. Default 5000. */
  eoseTimeoutMs?: number;
  /** How long a publish waits for each relay's answer. Default 5000. */
  publishTimeoutMs?: number;
  /** Events kept in memory to serve `localOnly` reads and read-after-write. Oldest dropped first. Default 5000. */
  maxCachedEvents?: number;
}

export interface RelayPoolStore extends FileEventStore {
  /** The normalized default relay set — what lookups fan out to. Doubles as `configuredRelays` for the Drive Key proof. */
  readonly relays: readonly string[];
  seenOn(eventId: string): Promise<string[]>;
  /** Closes every subscription and connection this store opened. Safe to call twice. */
  close(): void;
}

const DEFAULT_EOSE_TIMEOUT_MS = 5_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_CACHED = 5_000;

function normalizeAll(...lists: Array<readonly string[] | undefined>): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const url of list ?? []) {
      let normalized: string;
      try {
        normalized = normalizeURL(url);
      } catch {
        continue; // an unparseable hint must not break a read
      }
      if (!out.includes(normalized)) out.push(normalized);
    }
  }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

interface Observer {
  filters: Filter[];
  deliver(event: Event): void;
}

export function createRelayPoolStore(options: RelayPoolStoreOptions): RelayPoolStore {
  if (options.webSocket !== undefined) useWebSocketImplementation(options.webSocket);
  const defaults = normalizeAll(options.relays);
  const pool: RelayPoolLike = options.pool ?? (new SimplePool({ enablePing: true, enableReconnect: true }) as unknown as RelayPoolLike);
  // Without this the pool records nothing and seenOn — the Drive Key coverage proof — would be empty.
  pool.trackRelays = true;
  const eoseTimeoutMs = options.eoseTimeoutMs ?? DEFAULT_EOSE_TIMEOUT_MS;
  const publishTimeoutMs = options.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
  const maxCached = options.maxCachedEvents ?? DEFAULT_MAX_CACHED;

  const cache = new Map<string, Event>();
  const acceptedBy = new Map<string, Set<string>>();
  const observers = new Set<Observer>();
  const touched = new Set<string>();
  let closed = false;

  const remember = (event: Event) => {
    if (cache.has(event.id)) return;
    cache.set(event.id, event);
    // Map iterates in insertion order, so the first key is the oldest.
    while (cache.size > maxCached) cache.delete(cache.keys().next().value as string);
  };
  const track = (urls: string[]) => urls.forEach((url) => touched.add(url));
  const matches = (filters: Filter[], event: Event) => filters.some((filter) => matchFilter(filter, event));

  return {
    relays: defaults,

    observe(filters, handlers, observeOptions) {
      const seen = new Set<string>();
      const subs: Array<{ close(reason?: string): void }> = [];
      let stopped = closed;
      let eoseLeft = filters.length;

      const deliver = (event: Event) => {
        if (stopped || seen.has(event.id)) return;
        seen.add(event.id);
        remember(event);
        handlers.onEvent(event);
      };
      const eoseOnce = () => {
        eoseLeft -= 1;
        if (eoseLeft === 0 && !stopped) handlers.onEose?.();
      };
      const observer: Observer = { filters, deliver: (event) => { if (matches(filters, event)) deliver(event); } };
      observers.add(observer);

      // Cached events first (read-after-write: a publish is visible before any relay echoes it), as a
      // local store would. `localOnly` is exactly this and nothing more.
      queueMicrotask(() => {
        if (stopped) return;
        for (const event of [...cache.values()]) observer.deliver(event);
        // Nothing to wait for from the network: the cache replay IS the whole answer.
        if (observeOptions?.localOnly || filters.length === 0) handlers.onEose?.();
      });
      if (observeOptions?.localOnly || filters.length === 0) {
        return { unobserve: () => { stopped = true; observers.delete(observer); } };
      }

      const urls = normalizeAll(defaults, observeOptions?.relays);
      if (urls.length === 0) {
        queueMicrotask(() => { for (let i = 0; i < filters.length; i += 1) eoseOnce(); });
        return { unobserve: () => { stopped = true; observers.delete(observer); } };
      }
      track(urls);
      // SimplePool takes ONE filter per subscription, so a multi-filter interest is one subscription each;
      // end-of-stored-events is reported once every one of them has reported it.
      for (const filter of filters) {
        let reported = false;
        const report = () => { if (!reported) { reported = true; eoseOnce(); } };
        subs.push(pool.subscribeMany(urls, filter, {
          onevent: deliver,
          oneose: report,
          // Every relay closed (all failed): there is nothing more coming, so don't hang the caller.
          onclose: report,
          maxWait: eoseTimeoutMs,
        }));
      }
      return {
        unobserve() {
          stopped = true;
          observers.delete(observer);
          for (const sub of subs) {
            try { sub.close("unobserved"); } catch { /* already closed */ }
          }
        },
      };
    },

    async publishEvent(event, publishOptions) {
      if (closed) throw new Error("This relay pool store is closed");
      const urls = normalizeAll(defaults, publishOptions?.relays);
      track(urls);
      const attempts = pool.publish(urls, event, { maxWait: publishTimeoutMs });
      const settled = await Promise.allSettled(attempts.map((attempt) => withTimeout(attempt, publishTimeoutMs)));
      const relayResults: FileRelayOutcome[] = settled.map((outcome, index) => {
        const relay = urls[index]!;
        if (outcome.status === "fulfilled") return { relay, status: "accepted" };
        const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        return { relay, status: /timed? ?out/i.test(message) ? "timeout" : "rejected", message };
      });
      const accepted = relayResults.filter((r) => r.status === "accepted");
      const result: FilePublishResult = { ok: accepted.length > 0, accepted: accepted.length, total: relayResults.length, relayResults };
      if (result.ok) {
        // Held locally and handed to live observers at once, so a read right after a write sees it even
        // before a relay echoes it back. Only on success: an event no relay took must not look stored.
        remember(event);
        acceptedBy.set(event.id, new Set(accepted.map((r) => r.relay)));
        for (const observer of [...observers]) observer.deliver(event);
      }
      return result;
    },

    async seenOn(eventId) {
      const urls = new Set<string>(acceptedBy.get(eventId) ?? []);
      for (const relay of pool.seenOn?.get(eventId) ?? []) urls.add(relay.url);
      return [...urls];
    },

    close() {
      if (closed) return;
      closed = true;
      observers.clear();
      try { pool.close([...touched]); } catch { /* nothing open */ }
    },
  };
}
