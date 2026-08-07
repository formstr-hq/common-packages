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
import { generateFilterHash, matchFilter } from "./core/matchFilter";
import { Channel } from "./transport/channel";
import { WorkerHost } from "./transport/WorkerHost";
import type { Diagnostics } from "./transport/frames";
import { RelayPool } from "./sync/RelayPool";
import type { RelayHealth } from "./sync/RelayPool";
import { SyncEngine, SyncHandle, defaultVerify } from "./sync/SyncEngine";
import { DeliveryOutbox } from "./sync/DeliveryOutbox";
import { SocketFactory, webSocketFactory } from "./sync/Socket";
import { StorageAdapter } from "./storage/StorageAdapter";
import { Persistence, PersistenceOptions } from "./storage/persistence";

/** Enrichment batching: debounce window + per-flush cap on refs/profiles. */
const ENRICH_DEBOUNCE_MS = 200;
const ENRICH_BATCH = 200;

/**
 * Cap on the discovered (gossip) relay pool. Discovered relays come from
 * untrusted hints, so an unbounded pool is an amplification vector and risks the
 * browser's total-WebSocket ceiling (Firefox defaults to ~200). The pool is LRU:
 * the most-recently-added survive, so the cap bounds how many discovered relays
 * the worker ever dials.
 */
const DEFAULT_MAX_GOSSIP_RELAYS = 64;

/**
 * NIP-17 gift-wrap kind. An author-less interest scoped purely to these kinds is
 * a DM read: it targets the user's DM inbox relays (kind 10050), NOT the general
 * read/gossip relays — and general feed reads never touch the DM inbox relays.
 */
const DM_KINDS = new Set<number>([1059]);

/**
 * NIP-17 DM inbox relay list (kind 10050). A recipient receives gift wraps here,
 * deliberately separate from their kind-10002 read relays — so a DM publish must
 * target this list, never the outbox read relays.
 */
const DM_INBOX_KIND = 10050;

/**
 * "Online" debounce: we count as online if a user relay is connected now or was
 * within this window, so a brief socket blip doesn't flap the flag (or trigger
 * redundant outbox sweeps). See `isOnline`.
 */
const ONLINE_WINDOW_MS = 30_000;

/** Order-independent equality of two relay-url lists (treated as sets). */
function sameRelaySet(a: string[], b: string[]): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const url of setA) if (!setB.has(url)) return false;
  return true;
}

export interface RelayServiceOptions {
  channel: Channel;
  socketFactory?: SocketFactory;
  storage?: StorageAdapter;
  persistence?: PersistenceOptions;
  verify?: (event: Event) => boolean;
  now?: () => number;
  /** Max discovered relays kept in the gossip pool (LRU). Default 64. */
  maxGossipRelays?: number;
  /** Max wait for a relay's publish OK before it's marked timeout/failed. */
  publishTimeoutMs?: number;
  /** Tuning for the durable delivery outbox (retry backoff + give-up cap). */
  outbox?: {
    baseBackoffMs?: number;
    maxBackoffMs?: number;
    maxAttempts?: number;
  };
}

export class RelayService {
  readonly db: EventDB;
  private host: WorkerHost;
  private pool: RelayPool;
  private sync: SyncEngine;
  private outbox: DeliveryOutbox;
  private persistence: Persistence | null;
  private storage: StorageAdapter | null;
  private userRelays: string[] = [];
  /** Dedicated NIP-50 relays, kept out of ordinary feed and publish routing. */
  private searchRelays: string[] = [];
  /**
   * The user's NIP-17 DM inbox relays (kind 10050) — where their gift-wrapped DMs
   * are delivered. Kept separate from `userRelays` so the kind-1059 stream can
   * target them specifically while general feed reads stay off them.
   */
  private dmRelays: string[] = [];
  /**
   * Discovered relays from hints (DM-referenced notes, e/q-tag hints, …), kept
   * separate from `userRelays`. Used only on the read/discovery path (enrichment
   * + author-less fetches) to find referenced/missing events — never a publish
   * target. Ephemeral and LRU-bounded; most-recently-added is last.
   */
  private gossipRelays: string[] = [];
  private readonly maxGossipRelays: number;
  /** Standing interests by subscription id (the worker's only network input).
   *  `relays` are optional per-interest read-relay hints (see openSync). */
  private interests = new Map<
    string,
    { filters: Filter[]; sync: boolean; relays?: string[] }
  >();
  /** Live upstream subscriptions, deduped by filter-hash across interests.
   *  `relays` is the union of the per-interest relay hints for this scope, so a
   *  hint added by a later interest reopens the sub against the wider set. */
  private upstream = new Map<
    string,
    { filters: Filter[]; relays: string[]; handle: SyncHandle | null }
  >();
  private paused = false;
  private verify: (event: Event) => boolean;
  private now: () => number;
  private publishTimeoutMs?: number;
  /** Pending enrichment targets (referenced event ids + author pubkeys). */
  private enrichIds = new Set<string>();
  private enrichAuthors = new Set<string>();
  private enrichTimer: ReturnType<typeof setTimeout> | null = null;
  /** Already-requested enrichment targets, so we never re-fetch the same ref. */
  private enrichRequested = new Set<string>();
  /** Most recent time a USER relay socket was connected (drives `isOnline`). */
  private lastUserRelayConnectedAt = 0;
  /** One-shot timer that fires the next due outbox sweep (backoff retry). */
  private outboxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelayServiceOptions) {
    this.verify = opts.verify ?? defaultVerify;
    this.now = opts.now ?? (() => Date.now());
    this.publishTimeoutMs = opts.publishTimeoutMs;
    this.maxGossipRelays = opts.maxGossipRelays ?? DEFAULT_MAX_GOSSIP_RELAYS;
    this.db = new EventDB(opts.now);
    this.pool = new RelayPool(opts.socketFactory ?? webSocketFactory);
    this.host = new WorkerHost(opts.channel, this.db, {
      onSetUserRelays: (relays) => {
        const changed = !sameRelaySet(this.userRelays, relays);
        this.userRelays = relays;
        this.onRelaySetChanged(changed);
      },
      onSetSearchRelays: (relays) => {
        const changed = !sameRelaySet(this.searchRelays, relays);
        this.searchRelays = relays;
        this.onRelaySetChanged(changed);
      },
      onSetDmRelays: (relays) => {
        const changed = !sameRelaySet(this.dmRelays, relays);
        this.dmRelays = relays;
        this.onRelaySetChanged(changed);
      },
      onAddGossipRelay: (url) => this.addGossipRelay(url),
      onRemoveGossipRelay: (url) => this.removeGossipRelay(url),
      onObserve: (subId, filters, sync, relays) =>
        this.observe(subId, filters, sync, relays),
      onUnobserve: (subId) => this.unobserve(subId),
      onPublish: (pubId, event, relays) =>
        this.publishUpstream(pubId, event, relays),
      onRelayHealth: (reqId) =>
        this.host.postRelayHealth(reqId, this.relayHealth()),
      onSeenOn: (reqId, eventId) =>
        this.host.postSeenOn(reqId, this.db.seenOn(eventId)),
      onOnline: (reqId) => this.host.postOnline(reqId, this.isOnline()),
      onRetryDelivery: (eventId) => this.outbox.retry(eventId),
      onDiagnostics: (reqId) =>
        this.host.postDiagnostics(reqId, this.diagnostics()),
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
      recordSeen: (id, relay) => this.db.recordSeen(id, relay),
    });
    this.storage = opts.storage ?? null;
    this.persistence = opts.storage
      ? new Persistence(this.db, opts.storage, opts.persistence)
      : null;
    this.outbox = new DeliveryOutbox({
      now: this.now,
      getEvent: (id) => this.db.getById(id),
      publish: (relays, event, onResult) =>
        this.pool.publish(relays, event, {
          now: this.now,
          timeoutMs: this.publishTimeoutMs,
          onResult: (results) => {
            // A redelivery that lands still means the relay now has the event.
            for (const r of results) {
              if (r.status === "accepted")
                this.db.recordSeen(event.id, r.relay);
            }
            onResult(results);
          },
        }),
      storage: this.storage,
      onScheduled: () => this.scheduleOutboxFlush(),
      baseBackoffMs: opts.outbox?.baseBackoffMs,
      maxBackoffMs: opts.outbox?.maxBackoffMs,
      maxAttempts: opts.outbox?.maxAttempts,
    });
    // A relay (re)connecting is our only trustworthy "reachable" signal: flush any
    // delivery debt owed to it, and refresh online state if it's a user relay.
    this.pool.setOnConnect((relay) => this.onRelayConnect(relay));
    // Deletions, replaceable supersessions, and prunes all surface as store
    // `remove`s — drop any outbox debt for a vanished event in one place.
    this.db.onChange((change) => {
      if (change.type === "remove") this.outbox.remove(change.id);
    });
  }

  /** Hydrate from storage (events + outbox), begin write-through, and flush. */
  async start(): Promise<void> {
    await this.persistence?.start();
    if (this.storage) this.outbox.hydrate(await this.storage.loadOutbox());
    this.outbox.sweep(); // attempt any debt carried across a restart
  }

  async stop(): Promise<void> {
    if (this.enrichTimer) {
      clearTimeout(this.enrichTimer);
      this.enrichTimer = null;
    }
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
    for (const u of Array.from(this.upstream.values())) u.handle?.close();
    this.upstream.clear();
    this.interests.clear();
    this.pool.closeAll();
    await this.persistence?.stop();
  }

  // --- interests → autonomous upstream reconciliation -----------------------

  /** Register/replace a standing interest, then reconcile upstream subscriptions. */
  private observe(
    subId: string,
    filters: Filter[],
    sync: boolean,
    relays?: string[],
  ): void {
    this.interests.set(subId, { filters, sync, relays });
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
    // Union the per-interest relay hints across every interest that shares a
    // filter-hash, so one upstream sub reads from the combined hint set.
    const desired = new Map<string, { filters: Filter[]; relays: string[] }>();
    for (const { filters, sync, relays } of Array.from(
      this.interests.values(),
    )) {
      if (!sync) continue;
      const key = generateFilterHash(filters, []);
      const entry = desired.get(key);
      if (!entry) {
        desired.set(key, {
          filters,
          relays: relays ? Array.from(new Set(relays)) : [],
        });
      } else if (relays) {
        for (const r of relays)
          if (!entry.relays.includes(r)) entry.relays.push(r);
      }
    }
    // Open newly-wanted scopes, or REOPEN one whose relay-hint set changed (a
    // later interest widened it) so the sub targets the current relays.
    for (const [key, { filters, relays }] of Array.from(desired.entries())) {
      const existing = this.upstream.get(key);
      if (!existing) {
        this.upstream.set(key, {
          filters,
          relays,
          handle: this.openSync(filters, relays),
        });
      } else if (!sameRelaySet(existing.relays, relays)) {
        existing.handle?.close();
        this.upstream.set(key, {
          filters,
          relays,
          handle: this.openSync(filters, relays),
        });
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

  /**
   * Apply a user/DM relay-set change. A real change must REOPEN standing subs,
   * not just reconcile: reconcile() dedupes by filter-hash (relay-independent),
   * so an already-open scope is never reopened on the new relays. Author-less
   * subs (notably the kind-1059 DM stream) would otherwise stay bound to the old
   * relays — e.g. a user's NIP-17 DM inbox relays folding in after hydration
   * wouldn't take effect, so DMs delivered there wouldn't arrive live until a
   * pause/resume. An unchanged set still reconciles (cheap, and lets pending
   * interests find a home once relays first appear).
   */
  private onRelaySetChanged(changed: boolean): void {
    if (changed) this.reopenUpstream();
    else this.reconcile();
  }

  /**
   * Tear down every standing upstream sub and reconcile from scratch, so each
   * scope is reopened against the CURRENT relay set. Used when `userRelays`,
   * `searchRelays`, or `dmRelays` changes (standing subs derive from them —
   * author-scoped via SyncEngine's floor, author-less via `readRelays()`, DM
   * subs via `dmReadRelays()`).
   */
  private reopenUpstream(): void {
    if (this.paused) return;
    for (const entry of Array.from(this.upstream.values()))
      entry.handle?.close();
    this.upstream.clear();
    this.reconcile();
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
          if (!this.enrichRequested.has(id) && !this.db.getById(id))
            this.enrichIds.add(id);
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
    const relays = this.readRelays();
    if (this.paused || !relays.length) return;
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
      // Discovery path: also reach into the gossip pool to find referenced events
      // that may live on relays the user isn't subscribed to.
      const id = this.pool.subscribe(relays, filters, {
        onEvent: (event, relay) => {
          if (!this.verify(event)) return;
          this.ingest([event], false);
          this.db.recordSeen(event.id, relay);
        },
        onEose: () => this.pool.unsubscribe(id),
      });
    }

    // More than one batch's worth queued up — drain on the next tick.
    if (this.enrichIds.size || this.enrichAuthors.size) this.scheduleEnrich();
  }

  /**
   * Open a standing upstream subscription for a scope. Author-scoped filters are
   * outbox-partitioned via SyncEngine (gossip relays stay out of the feed
   * firehose); DM (kind-1059) reads hit the user's DM inbox relays; other
   * author-less ones (e.g. a `{ ids }` fetch of a DM-referenced note) hit the
   * user's relays ∪ the gossip pool, so discovered hints can resolve them.
   *
   * `hintRelays` are the interest's explicit read-relay hints (e.g. a form's
   * naddr relays). They're folded into BOTH paths — as uncapped additional
   * relays for author-scoped outbox queries and as additions to author-less
   * reads — so a fetch reaches relays the app knows hold the data without
   * mutating the global gossip pool.
   */
  private openSync(filters: Filter[], hintRelays: string[] = []): SyncHandle {
    const handles: SyncHandle[] = [];
    for (const filter of filters) {
      const kinds = filter.kinds ?? [];
      if (this.isSearchFilter(filter)) {
        const relays = Array.from(
          new Set([...this.searchReadRelays(), ...hintRelays]),
        );
        if (relays.length) {
          const id = this.pool.subscribe(relays, [filter], {
            onEvent: (event, relay) => {
              if (!this.verify(event) || !matchFilter(event, filter)) return;
              this.ingest([event]);
              this.db.recordSeen(event.id, relay);
            },
          });
          handles.push({ close: () => this.pool.unsubscribe(id) });
        }
      } else if (filter.authors && filter.authors.length) {
        handles.push(
          this.sync.fetch({
            ...filter,
            kinds,
            authors: filter.authors,
            userRelays: this.userRelays,
            additionalRelays: hintRelays,
          }),
        );
      } else {
        const base = this.isDmFilter(filter)
          ? this.dmReadRelays()
          : this.readRelays();
        const relays = Array.from(new Set([...base, ...hintRelays]));
        if (relays.length) {
          const id = this.pool.subscribe(relays, [filter], {
            onEvent: (event, relay) => {
              if (!this.verify(event)) return;
              this.ingest([event]);
              this.db.recordSeen(event.id, relay);
            },
          });
          handles.push({ close: () => this.pool.unsubscribe(id) });
        }
      }
    }
    return { close: () => handles.forEach((h) => h.close()) };
  }

  // --- writes ---------------------------------------------------------------

  /**
   * Publish a client event upstream with per-relay tracking. Targets are the
   * author's write relays (outbox) ∪ the user's relays, plus the read relays of
   * any p-tagged pubkey (gossip) — except for DMs, which route to recipient inbox
   * relays instead (see `publishTargets`). `hintRelays` are explicit targets the
   * caller supplies for relays the worker can't derive. The worker owns routing;
   * retry is just another publish. Always reports a result so the diagnostics UI
   * never hangs.
   *
   * Targets that don't accept (timeout / unreachable — NOT outright rejection)
   * become durable outbox debt, re-delivered on reconnect until they land.
   */
  private publishUpstream(
    pubId: string,
    event: Event,
    hintRelays?: string[],
  ): void {
    const targets = this.publishTargets(event, hintRelays);
    this.pool.publish(targets, event, {
      now: this.now,
      timeoutMs: this.publishTimeoutMs,
      onResult: (results) => {
        const owed: string[] = [];
        for (const r of results) {
          // Accepted → it has the event (count as seen). Timeout/failed → owed,
          // retry later. Rejected → terminal refusal, never retried.
          if (r.status === "accepted") this.db.recordSeen(event.id, r.relay);
          else if (r.status === "timeout" || r.status === "failed")
            owed.push(r.relay);
        }
        // Only queue debt for an event that's actually in the store (skip
        // ephemerals, which aren't stored and so can't be re-sent).
        if (owed.length && this.db.getById(event.id))
          this.outbox.mark(event.id, owed);
        this.host.postPublishResult(pubId, results);
      },
    });
  }

  private publishTargets(event: Event, hintRelays: string[] = []): string[] {
    // NIP-17 gift wraps don't follow the NIP-65 outbox model. Each is signed by a
    // throwaway per-message key, so `getWriteRelays(event.pubkey)` is empty; and a
    // recipient receives them on their kind-10050 DM inbox, which is deliberately
    // separate from the kind-10002 read relays the generic path below would use.
    // Routing a wrap to a recipient's read relays is both wrong (it may never
    // reach their inbox) and leaky, so DMs get their own routing.
    if (DM_KINDS.has(event.kind)) return this.dmPublishTargets(event, hintRelays);

    const targets = new Set<string>([
      ...this.getWriteRelays(event.pubkey),
      ...this.userRelays,
      ...hintRelays,
    ]);
    for (const tag of event.tags) {
      if (tag[0] === "p" && tag[1]) {
        for (const relay of this.getReadRelays(tag[1])) targets.add(relay);
      }
    }
    return Array.from(targets);
  }

  /**
   * Delivery targets for a NIP-17 gift wrap, degrading through progressively
   * weaker sources so a wrap still ships when a recipient hasn't published the
   * ideal relay list:
   *
   *  1. The recipient's DM inbox (kind 10050) — the correct NIP-17 target. Two
   *     sources, unioned: `hintRelays` (the caller resolved the 10050 to compose
   *     the message — the worker can't discover an arbitrary pubkey's inbox on
   *     its own) and any kind-10050 already in the store.
   *  2. NIP-65 fallback — the recipient's kind-10002 read relays, used only when
   *     no inbox was found for anyone. Not spec-ideal for a DM, but where a
   *     reader without a 10050 is most likely to see it.
   *  3. Default fallback — `userRelays`, the last resort so a wrap goes somewhere
   *     rather than nowhere.
   *
   * Never the gossip pool. The read-relay tier is a fallback only — when an inbox
   * is known it is never mixed in, so a DM isn't broadened onto read relays.
   */
  private dmPublishTargets(event: Event, hintRelays: string[]): string[] {
    const targets = new Set<string>(hintRelays);
    let haveInbox = hintRelays.length > 0;
    for (const tag of event.tags) {
      if (tag[0] !== "p" || !tag[1]) continue;
      const inbox = this.dmInboxRelays(tag[1]);
      if (inbox.length) {
        for (const relay of inbox) targets.add(relay);
        haveInbox = true;
      }
    }

    // (2) NIP-65 read relays, only when no recipient inbox was found at all.
    if (!haveInbox) {
      for (const tag of event.tags) {
        if (tag[0] !== "p" || !tag[1]) continue;
        for (const relay of this.getReadRelays(tag[1])) targets.add(relay);
      }
    }

    // (3) The default relay set, only when nothing else resolved.
    if (targets.size === 0) for (const relay of this.userRelays) targets.add(relay);
    return Array.from(targets);
  }

  /** Parse a pubkey's latest kind-10050 (NIP-17 DM inbox) from the store. */
  private dmInboxRelays(pubkey: string): string[] {
    const [event] = this.db.query({
      kinds: [DM_INBOX_KIND],
      authors: [pubkey],
      limit: 1,
    });
    if (!event) return [];
    const out: string[] = [];
    for (const tag of event.tags) {
      if (tag[0] === "relay" && tag[1]) out.push(tag[1]);
    }
    return out;
  }

  // --- lifecycle ------------------------------------------------------------

  /** App backgrounded: close every socket, keep the store + interests. */
  private pause(): void {
    this.paused = true;
    if (this.enrichTimer) {
      clearTimeout(this.enrichTimer);
      this.enrichTimer = null;
    }
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
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
    // Re-attempt delivery debt: pause() tore down the sockets, so owed relays
    // need fresh connections (the attempt itself reopens them).
    this.outbox.sweep();
  }

  // --- outbox delivery-on-reconnect + online state --------------------------

  /**
   * A relay socket reached OPEN — our only trustworthy reachability signal. Note
   * when a user relay connects (feeds `isOnline`) and flush any delivery debt owed
   * to this relay right away (it's demonstrably up).
   */
  private onRelayConnect(relay: string): void {
    if (this.userRelays.includes(relay))
      this.lastUserRelayConnectedAt = this.now();
    this.outbox.flushRelay(relay);
  }

  /**
   * Online = a user relay is connected now, or was within the last 30s (debounced
   * so a brief drop doesn't flap). Computed from live socket state — never a guess
   * (`navigator.onLine` lies about captive portals / LAN-without-WAN).
   */
  isOnline(): boolean {
    const connectedNow = this.pool
      .relayHealth(this.userRelays)
      .some((h) => h.connected);
    return (
      connectedNow ||
      this.now() - this.lastUserRelayConnectedAt < ONLINE_WINDOW_MS
    );
  }

  /** Arm a single one-shot timer for the next due outbox retry (backoff sweep). */
  private scheduleOutboxFlush(): void {
    if (this.outboxTimer) {
      clearTimeout(this.outboxTimer);
      this.outboxTimer = null;
    }
    if (this.paused) return;
    const earliest = this.outbox.earliestNextAttemptAt();
    if (earliest === null) return; // nothing pending (or all in flight)
    const delay = Math.max(0, earliest - this.now());
    this.outboxTimer = setTimeout(() => {
      this.outboxTimer = null;
      this.outbox.sweep();
    }, delay);
  }

  // --- gossip pool ----------------------------------------------------------

  /**
   * Add a discovered relay to the gossip pool (LRU). Takes effect for subsequent
   * author-less fetches and the next enrichment flush — it does not re-open
   * existing subscriptions. Re-adding an existing url marks it most-recent.
   */
  private addGossipRelay(url: string): void {
    const existing = this.gossipRelays.indexOf(url);
    if (existing !== -1) this.gossipRelays.splice(existing, 1);
    this.gossipRelays.push(url);
    if (this.gossipRelays.length > this.maxGossipRelays)
      this.gossipRelays.shift();
  }

  /**
   * Drop a discovered relay from the pool so future fetches stop targeting it.
   * Membership only — an already-open socket closes on the next pause()/resume.
   */
  private removeGossipRelay(url: string): void {
    const i = this.gossipRelays.indexOf(url);
    if (i !== -1) this.gossipRelays.splice(i, 1);
  }

  /** Relays the read/discovery path may use: user relays ∪ the gossip pool. */
  private readRelays(): string[] {
    return Array.from(new Set([...this.userRelays, ...this.gossipRelays]));
  }

  /** Dedicated search relays, falling back to the ordinary read set. */
  private searchReadRelays(): string[] {
    return this.searchRelays.length
      ? Array.from(new Set(this.searchRelays))
      : this.readRelays();
  }

  /**
   * Relays a DM (kind-1059) read targets: the user's NIP-17 inbox relays, with
   * the user's general relays as a fallback so DMs still arrive before any 10050
   * is known. Deliberately excludes the gossip pool (DMs aren't discovered).
   */
  private dmReadRelays(): string[] {
    return Array.from(new Set([...this.dmRelays, ...this.userRelays]));
  }

  /**
   * True for a filter scoped purely to DM kinds — a DM inbox read. Only ever
   * called on the author-less branch (author-scoped filters route via outbox), so
   * it need not re-check authors.
   */
  private isDmFilter(filter: Filter): boolean {
    const kinds = filter.kinds;
    return !!kinds && kinds.length > 0 && kinds.every((k) => DM_KINDS.has(k));
  }

  private isSearchFilter(filter: Filter): boolean {
    return typeof filter.search === "string" && filter.search.trim().length > 0;
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
    const [event] = this.db.query({
      kinds: [10002],
      authors: [pubkey],
      limit: 1,
    });
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
    const relays = this.relayHealth();
    const connected = relays.filter((r) => r.connected);
    const userSet = new Set(this.userRelays);
    return {
      paused: this.paused,
      online: this.isOnline(),
      interests: Array.from(this.interests.entries()).map(([subId, i]) => ({
        subId,
        filters: i.filters,
        sync: i.sync,
      })),
      upstream: Array.from(this.upstream.entries()).map(([filterHash, u]) => ({
        filterHash,
        filters: u.filters,
        relays: Array.from(
          new Set([...this.routeRelays(u.filters), ...u.relays]),
        ),
      })),
      relays,
      dmRelays: [...this.dmRelays],
      searchRelays: [...this.searchRelays],
      gossipRelays: [...this.gossipRelays],
      connections: {
        user: connected.filter((r) => userSet.has(r.relay)).length,
        gossip: connected.filter((r) => r.gossip).length,
        outbox: connected.filter((r) => !userSet.has(r.relay) && !r.gossip)
          .length,
        total: connected.length,
      },
      cache: this.db.stats(),
      enrichment: {
        queuedIds: this.enrichIds.size,
        queuedAuthors: this.enrichAuthors.size,
        pending: this.enrichTimer !== null,
      },
      delivery: {
        records: this.outbox.snapshot(),
        pendingRelays: this.outbox.pendingCount(),
        failed: this.outbox.failedCount(),
      },
    };
  }

  /**
   * Candidate relays a set of filters routes to. Author-scoped filters go to the
   * authors' outbox ∪ user relays; author-less ones add the gossip pool (mirrors
   * `openSync`).
   */
  private routeRelays(filters: Filter[]): string[] {
    const relays = new Set<string>();
    for (const filter of filters) {
      if (this.isSearchFilter(filter)) {
        for (const relay of this.searchReadRelays()) relays.add(relay);
      } else if (filter.authors && filter.authors.length) {
        for (const pubkey of filter.authors) {
          for (const relay of this.getWriteRelays(pubkey)) relays.add(relay);
        }
        for (const relay of this.userRelays) relays.add(relay);
      } else {
        const targets = this.isDmFilter(filter)
          ? this.dmReadRelays()
          : this.readRelays();
        for (const relay of targets) relays.add(relay);
      }
    }
    return Array.from(relays);
  }

  /**
   * Live connection health for the user's relays (configured + any connected),
   * each tagged with whether it's a discovered (gossip) relay.
   */
  private relayHealth(): RelayHealth[] {
    const fromPool = this.pool.relayHealth();
    const seen = new Set(fromPool.map((h) => h.relay));
    const missing: RelayHealth[] = Array.from(new Set(this.userRelays))
      .filter((r) => !seen.has(r))
      .map((relay) => ({
        relay,
        connected: false,
        connecting: false,
        reconnecting: false,
        gossip: false,
      }));
    const userSet = new Set(this.userRelays);
    const gossipSet = new Set(this.gossipRelays);
    return [...fromPool, ...missing].map((h) => ({
      ...h,
      gossip: gossipSet.has(h.relay) && !userSet.has(h.relay),
    }));
  }
}
