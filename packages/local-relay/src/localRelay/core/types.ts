/**
 * Core types for the local relay.
 *
 * This module is platform-free: it imports nothing but nostr-tools types and is
 * safe to run in a Worker, in Node (tests), or on the main thread. Nothing here
 * touches the network, the DOM, IndexedDB, or React.
 */
import type { Event, Filter } from "nostr-tools";

export type { Event, Filter };

/** Callback fired when the store changes. `type` distinguishes the cause. */
export type StoreChange =
  | { type: "add"; event: Event }
  | { type: "remove"; id: string }
  // A batch of events entered the store WITHOUT per-event `add` emits (boot
  // hydration from persistence). Live-sub owners must re-scan the store against
  // their filters and deliver any now-available matches — a sub registered
  // before hydration finished replayed an empty store and would otherwise never
  // see the hydrated events (the later network copy is dropped as a duplicate).
  | { type: "reset" };

export type StoreListener = (change: StoreChange) => void;

/**
 * A durable outbox entry: an event we published that hasn't reached all its
 * target relays yet, so the worker keeps re-delivering until it lands (or gives
 * up). The event body lives in the event store; this only tracks delivery debt.
 */
export interface OutboxRecord {
  /** Id of the published event (looked up from the event store to re-send). */
  eventId: string;
  /** Target relays that haven't accepted yet and haven't terminally rejected. */
  pending: string[];
  /** Delivery attempts made so far (drives backoff + the give-up cap). */
  attempts: number;
  /** Epoch ms before which the next sweep should skip this record (backoff). */
  nextAttemptAt: number;
  /**
   * Set once the give-up cap is hit: auto-retry stops, but the record is KEPT so
   * the client can list it and trigger a manual retry later. Cleared by retry.
   */
  failed: boolean;
}

/** Statistics about the store — used for debug + prune decisions. */
export interface DBStats {
  totalEvents: number;
  eventsByKind: Record<number, number>;
  totalAuthors: number;
}

/**
 * Pruning policy. created_at-based TTLs are in SECONDS (matching Nostr
 * timestamps); the hard cap and cadence are counts/ms handled by the scheduler.
 *
 * `protectedKinds` are never pruned regardless of age — profiles, contacts,
 * relay lists, and replaceable lists are tiny and load-bearing.
 */
export interface PrunePolicy {
  /** Kinds never pruned by age or cap. */
  protectedKinds: Set<number>;
  /** Per-kind TTL in seconds. Falls back to `defaultTtlSeconds`. */
  ttlByKind: Map<number, number>;
  /** TTL for any non-protected kind without an explicit entry. */
  defaultTtlSeconds: number;
  /** Hard cap on total stored events; oldest non-protected evicted past this. */
  maxEvents: number;
}

/**
 * Default pruning policy (see docs/local-relay-design.md §7).
 * Protected: profiles (0), contacts (3), relay lists (10002), and the
 * 10000-series replaceable lists (mutes, bookmarks, interests, …).
 */
export function defaultPrunePolicy(): PrunePolicy {
  const DAY = 24 * 60 * 60;
  const protectedKinds = new Set<number>([0, 3, 10002]);
  // 10000–19999 are replaceable lists — protect the whole range.
  for (let k = 10000; k < 20000; k++) protectedKinds.add(k);

  const ttlByKind = new Map<number, number>([
    [30023, 30 * DAY], // long-form articles
    [1068, 30 * DAY], // polls
  ]);

  return {
    protectedKinds,
    ttlByKind,
    defaultTtlSeconds: 7 * DAY, // notes, reposts, reactions, responses
    maxEvents: 50_000,
  };
}
