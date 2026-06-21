/**
 * RelayService — the worker-side assembly of the entire local relay. Wires
 * EventDB + RelayCore (via WorkerHost) + Persistence + RelayPool + SyncEngine.
 *
 * Core invariant: the main thread only DECLARES INTERESTS (observe/observeOnce)
 * and PUBLISHES. This service owns every connection decision. It holds the set
 * of standing interests and *reconciles* its upstream subscriptions from their
 * union (deduped by filter-hash, outbox-routed) — so presentation churn never
 * opens/closes sockets directly: adding/removing an interest is the only input,
 * and the worker decides if/when/how to touch relays.
 *
 * Platform-agnostic: Channel, SocketFactory, StorageAdapter, verify, and clock
 * are injected, so it's tested end-to-end over a fake channel + FakeSocket.
 */
import type { Event, Filter } from "./core/types";
import { EventDB } from "./core/EventDB";
import { generateFilterHash } from "./core/matchFilter";
import { Channel } from "./transport/channel";
import { WorkerHost } from "./transport/WorkerHost";
import type { Diagnostics } from "./transport/frames";
import { RelayPool } from "./sync/RelayPool";
import { SyncEngine, SyncHandle, defaultVerify } from "./sync/SyncEngine";
import { SocketFactory, webSocketFactory } from "./sync/Socket";
import { StorageAdapter } from "./storage/StorageAdapter";
import { Persistence, PersistenceOptions } from "./storage/persistence";

/** Enrichment batching: debounce window + per-flush cap on refs/profiles. */
const ENRICH_DEBOUNCE_MS = 200;
const ENRICH_BATCH = 200;

export interface RelayServiceOptions {
  channel: Channel;
  socketFactory?: SocketFactory;
  storage?: StorageAdapter;
  persistence?: PersistenceOptions;
  verify?: (event: Event) => boolean;
  now?: () => number;
}

export class RelayService {
  readonly db: EventDB;
  private host: WorkerHost;
  private pool: RelayPool;
  private sync: SyncEngine;
  private persistence: Persistence | null;
  private userRelays: string[] = [];
  /** Standing interests by subscription id (the worker's only network input). */
  private interests = new Map<string, { filters: Filter[]; sync: boolean }>();
  /** Live upstream subscriptions, deduped by filter-hash across interests. */
  private upstream = new Map<string, { filters: Filter[]; handle: SyncHandle | null }>();
  private paused = false;
  private verify: (event: Event) => boolean;
  private now: () => number;
  /** Pending enrichment targets (referenced event ids + author pubkeys). */
  private enrichIds = new Set<string>();
  private enrichAuthors = new Set<string>();
  private enrichTimer: ReturnType<typeof setTimeout> | null = null;
  /** Already-requested enrichment targets, so we never re-fetch the same ref. */
  private enrichRequested = new Set<string>();

  constructor(opts: RelayServiceOptions) {
    this.verify = opts.verify ?? defaultVerify;
    this.now = opts.now ?? (() => Date.now());
    this.db = new EventDB(opts.now);
    this.pool = new RelayPool(opts.socketFactory ?? webSocketFactory);
    this.host = new WorkerHost(opts.channel, this.db, {
      onSetUserRelays: (relays) => {
        this.userRelays = relays;
        this.reconcile(); // new relays may let pending interests find a home
      },
      onObserve: (subId, filters, sync) => this.observe(subId, filters, sync),
      onUnobserve: (subId) => this.unobserve(subId),
      onPublish: (pubId, event) => this.publishUpstream(pubId, event),
      onRelayHealth: (reqId) => this.host.postRelayHealth(reqId, this.relayHealth()),
      onDiagnostics: (reqId) => this.host.postDiagnostics(reqId, this.diagnostics()),
      onPause: () => this.pause(),
      onResume: () => this.resume(),
      // onSetAccount handled by the cutover wiring (retarget feeds); the shared
      // public store does not need a swap.
    });
    this.sync = new SyncEngine({
      pool: this.pool,
      ingest: (events) => this.ingest(events),
      getWriteRelays: (pk) => this.getWriteRelays(pk),
      verify: opts.verify,
    });
    this.persistence = opts.storage
      ? new Persistence(this.db, opts.storage, opts.persistence)
      : null;
  }

  /** Hydrate from storage and begin write-through + pruning. */
  async start(): Promise<void> {
    await this.persistence?.start();
  }

  async stop(): Promise<void> {
    if (this.enrichTimer) {
      clearTimeout(this.enrichTimer);
      this.enrichTimer = null;
    }
    for (const u of Array.from(this.upstream.values())) u.handle?.close();
    this.upstream.clear();
    this.interests.clear();
    this.pool.closeAll();
    await this.persistence?.stop();
  }

  // --- interests → autonomous upstream reconciliation -----------------------

  /** Register/replace a standing interest, then reconcile upstream subscriptions. */
  private observe(subId: string, filters: Filter[], sync: boolean): void {
    this.interests.set(subId, { filters, sync });
    this.reconcile();
  }

  private unobserve(subId: string): void {
    if (this.interests.delete(subId)) this.reconcile();
  }

  /**
   * Bring live upstream subscriptions in line with the union of sync-interests,
   * deduped by filter-hash so N components on the same scope share ONE upstream.
   * The worker — not the app — decides what to open and close here.
   */
  private reconcile(): void {
    if (this.paused) return;
    const desired = new Map<string, Filter[]>();
    for (const { filters, sync } of Array.from(this.interests.values())) {
      if (!sync) continue;
      const key = generateFilterHash(filters, []);
      if (!desired.has(key)) desired.set(key, filters);
    }
    // Open newly-wanted scopes.
    for (const [key, filters] of Array.from(desired.entries())) {
      if (!this.upstream.has(key)) {
        this.upstream.set(key, { filters, handle: this.openSync(filters) });
      }
    }
    // Drop scopes no interest wants anymore.
    for (const [key, entry] of Array.from(this.upstream.entries())) {
      if (!desired.has(key)) {
        entry.handle?.close();
        this.upstream.delete(key);
      }
    }
  }

  // --- store ingest + autonomous enrichment ---------------------------------

  /**
   * The single sink for events entering the store. Beyond writing them, the
   * worker ENRICHES on its own affordance: it queues the referenced events
   * (`e`/`q` tags) and authors (kind-0 profiles) of anything it syncs, so
   * cache-only reads (`useEvent`/`fetchById`) find referenced notes + profiles
   * already present. Enrichment fetches are ingested with `enrich=false` so a
   * reference never cascades into an unbounded crawl.
   */
  private ingest(events: Event[], enrich = true): void {
    this.host.ingest(events);
    if (enrich) this.enqueueEnrichment(events);
  }

  /** Collect not-yet-known referenced ids + author profiles to fetch. */
  private enqueueEnrichment(events: Event[]): void {
    for (const event of events) {
      for (const tag of event.tags) {
        if ((tag[0] === "e" || tag[0] === "q") && tag[1]) {
          const id = tag[1];
          if (!this.enrichRequested.has(id) && !this.db.getById(id)) this.enrichIds.add(id);
        }
      }
      const pk = event.pubkey;
      const authorKey = `0:${pk}`;
      if (
        !this.enrichRequested.has(authorKey) &&
        this.db.query({ kinds: [0], authors: [pk], limit: 1 }).length === 0
      ) {
        this.enrichAuthors.add(pk);
      }
    }
    if (this.enrichIds.size || this.enrichAuthors.size) this.scheduleEnrich();
  }

  /** Debounce enrichment so a burst of ingests yields one batched upstream read. */
  private scheduleEnrich(): void {
    if (this.paused || this.enrichTimer) return;
    this.enrichTimer = setTimeout(() => {
      this.enrichTimer = null;
      this.flushEnrichment();
    }, ENRICH_DEBOUNCE_MS);
  }

  /**
   * Fetch a capped batch of queued references + author profiles from the user's
   * relays, ingest them WITHOUT re-enriching, and close on EOSE. Capped so a busy
   * feed can never make the worker open an unbounded number of reads.
   */
  private flushEnrichment(): void {
    if (this.paused || !this.userRelays.length) return;
    const ids = Array.from(this.enrichIds).slice(0, ENRICH_BATCH);
    const authors = Array.from(this.enrichAuthors).slice(0, ENRICH_BATCH);
    ids.forEach((id) => {
      this.enrichIds.delete(id);
      this.enrichRequested.add(id);
    });
    authors.forEach((pk) => {
      this.enrichAuthors.delete(pk);
      this.enrichRequested.add(`0:${pk}`);
    });

    const filters: Filter[] = [];
    if (ids.length) filters.push({ ids });
    if (authors.length) filters.push({ kinds: [0], authors });
    if (filters.length) {
      const id = this.pool.subscribe(this.userRelays, filters, {
        onEvent: (event) => {
          if (this.verify(event)) this.ingest([event], false);
        },
        onEose: () => this.pool.unsubscribe(id),
      });
    }

    // More than one batch's worth queued up — drain on the next tick.
    if (this.enrichIds.size || this.enrichAuthors.size) this.scheduleEnrich();
  }

  /**
   * Open a standing upstream subscription for a scope. Author-scoped filters are
   * outbox-partitioned via SyncEngine; author-less ones hit the user's relays.
   */
  private openSync(filters: Filter[]): SyncHandle {
    const handles: SyncHandle[] = [];
    for (const filter of filters) {
      const kinds = filter.kinds ?? [];
      if (filter.authors && filter.authors.length) {
        handles.push(
          this.sync.fetch({
            kinds,
            authors: filter.authors,
            userRelays: this.userRelays,
            since: filter.since,
            until: filter.until,
            limit: filter.limit,
          })
        );
      } else if (this.userRelays.length) {
        const id = this.pool.subscribe(this.userRelays, [filter], {
          onEvent: (event) => {
            if (this.verify(event)) this.ingest([event]);
          },
        });
        handles.push({ close: () => this.pool.unsubscribe(id) });
      }
    }
    return { close: () => handles.forEach((h) => h.close()) };
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Publish a client event upstream with per-relay tracking. Targets are the
   * author's write relays (outbox) ∪ the user's relays, plus the inbox relays of
   * any p-tagged pubkey (gossip). The worker owns routing; retry is just another
   * publish. Always reports a result so the diagnostics UI never hangs.
   */
  private publishUpstream(pubId: string, event: Event): void {
    this.pool.publish(this.publishTargets(event), event, {
      now: this.now,
      onResult: (results) => this.host.postPublishResult(pubId, results),
    });
  }

  private publishTargets(event: Event): string[] {
    const targets = new Set<string>([...this.getWriteRelays(event.pubkey), ...this.userRelays]);
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]) {
        for (const relay of this.getReadRelays(tag[1])) targets.add(relay);
      }
    }
    return Array.from(targets);
  }

  // --- lifecycle ------------------------------------------------------------

  /** App backgrounded: close every socket, keep the store + interests. */
  private pause(): void {
    this.paused = true;
    if (this.enrichTimer) {
      clearTimeout(this.enrichTimer);
      this.enrichTimer = null;
    }
    for (const entry of Array.from(this.upstream.values())) {
      entry.handle?.close();
      entry.handle = null;
    }
    this.upstream.clear();
    this.pool.closeAll();
  }

  /** App foregrounded: reconcile reopens the upstream from standing interests. */
  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.reconcile();
    // Drain any enrichment queued while backgrounded.
    if (this.enrichIds.size || this.enrichAuthors.size) this.scheduleEnrich();
  }

  // --- helpers --------------------------------------------------------------

  /** Outbox cache IS the store: parse the latest kind-10002 for this pubkey. */
  private getWriteRelays(pubkey: string): string[] {
    return this.relaysFromNip65(pubkey, "write");
  }

  /** Inbox relays — where a recipient reads — for gossip delivery of mentions. */
  private getReadRelays(pubkey: string): string[] {
    return this.relaysFromNip65(pubkey, "read");
  }

  /** Parse a pubkey's latest kind-10002, returning the relays for one direction. */
  private relaysFromNip65(pubkey: string, dir: "read" | "write"): string[] {
    const [event] = this.db.query({ kinds: [10002], authors: [pubkey], limit: 1 });
    if (!event) return [];
    const out: string[] = [];
    for (const tag of event.tags) {
      if (tag[0] !== "r" || !tag[1]) continue;
      // An unmarked "r" tag is both read and write.
      if (!tag[2] || tag[2] === dir) out.push(tag[1]);
    }
    return out;
  }

  /**
   * Read-only snapshot of the worker's state for debugging. Pure observation —
   * touches no sockets and mutates nothing. Surfaces the things you can't see
   * from the main thread: whether the worker is paused, which interests it holds,
   * what it's actually subscribed to upstream (and where), and the store size.
   */
  private diagnostics(): Diagnostics {
    return {
      paused: this.paused,
      interests: Array.from(this.interests.entries()).map(([subId, i]) => ({
        subId,
        filters: i.filters,
        sync: i.sync,
      })),
      upstream: Array.from(this.upstream.entries()).map(([filterHash, u]) => ({
        filterHash,
        filters: u.filters,
        relays: this.routeRelays(u.filters),
      })),
      relays: this.relayHealth(),
      cache: this.db.stats(),
      enrichment: {
        queuedIds: this.enrichIds.size,
        queuedAuthors: this.enrichAuthors.size,
        pending: this.enrichTimer !== null,
      },
    };
  }

  /** Candidate relays a set of filters routes to (author outbox ∪ user relays). */
  private routeRelays(filters: Filter[]): string[] {
    const relays = new Set<string>();
    for (const filter of filters) {
      if (filter.authors && filter.authors.length) {
        for (const pubkey of filter.authors) {
          for (const relay of this.getWriteRelays(pubkey)) relays.add(relay);
        }
      }
      for (const relay of this.userRelays) relays.add(relay);
    }
    return Array.from(relays);
  }

  /** Live connection health for the user's relays (configured + any connected). */
  private relayHealth() {
    const fromPool = this.pool.relayHealth();
    const seen = new Set(fromPool.map((h) => h.relay));
    const missing = Array.from(new Set(this.userRelays))
      .filter((r) => !seen.has(r))
      .map((relay) => ({ relay, connected: false, connecting: false, reconnecting: false }));
    return [...fromPool, ...missing];
  }
}
