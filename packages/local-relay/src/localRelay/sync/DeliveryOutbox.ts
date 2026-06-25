/**
 * DeliveryOutbox — durable delivery-on-reconnect for events the user published
 * while (partly) offline. A publish fans out to N target relays; the ones that
 * don't accept (timeout / unreachable — NOT outright rejection) become delivery
 * debt recorded here and retried until they land or we give up.
 *
 * Pure logic over injected `publish` / `getEvent` / `now` + a best-effort
 * `OutboxStorage`, so it's testable with no real network, timers, or IndexedDB.
 * Triggers (relay connect, resume, the online edge, the backoff timer) live in
 * RelayService; this class just owns the records and the per-attempt bookkeeping.
 *
 * Cleanup is unified through `remove(eventId)`: RelayService calls it from the
 * EventDB `remove` change, so a NIP-09 deletion, a replaceable supersession, or a
 * prune all drop the matching debt for free.
 */
import type { Event, OutboxRecord } from "../core/types";
import type { RelayPublishOutcome } from "./RelayPool";

export interface OutboxStorage {
  putOutbox(records: OutboxRecord[]): Promise<void>;
  deleteOutbox(eventIds: string[]): Promise<void>;
}

export interface DeliveryOutboxDeps {
  now: () => number;
  /** The stored event for an id, or undefined if it's gone/expired (→ drop it). */
  getEvent: (id: string) => Event | undefined;
  /** Publish an event to specific relays; reports each relay's outcome once. */
  publish: (
    relays: string[],
    event: Event,
    onResult: (results: RelayPublishOutcome[]) => void
  ) => void;
  /** Durable persistence; null = in-memory only (lost on restart). */
  storage?: OutboxStorage | null;
  /** Called when the earliest due-time may have changed, so the owner can
   *  (re)arm its retry timer. */
  onScheduled?: () => void;
  /** First retry delay; doubles each failed attempt up to `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Failed attempts after which a record is abandoned. */
  maxAttempts?: number;
}

const DEFAULTS = { baseBackoffMs: 2_000, maxBackoffMs: 300_000, maxAttempts: 8 };

export class DeliveryOutbox {
  private records = new Map<string, OutboxRecord>();
  /** Event ids with an attempt awaiting its publish result — never sent twice. */
  private inFlight = new Set<string>();
  private readonly base: number;
  private readonly max: number;
  private readonly maxAttempts: number;

  constructor(private deps: DeliveryOutboxDeps) {
    this.base = deps.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
    this.max = deps.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
    this.maxAttempts = deps.maxAttempts ?? DEFAULTS.maxAttempts;
  }

  /** Load persisted records on boot (skips any that arrived empty). */
  hydrate(records: OutboxRecord[]): void {
    for (const r of records) {
      if (r.pending.length) this.records.set(r.eventId, { ...r });
    }
    this.deps.onScheduled?.();
  }

  /**
   * Record that `relays` still owe delivery of `eventId` (the transiently-failed
   * targets of a publish). Unions into any existing debt and schedules it for the
   * next sweep. No-op for an empty relay set.
   */
  mark(eventId: string, relays: string[]): void {
    if (!relays.length) return;
    const existing = this.records.get(eventId);
    if (existing) {
      const pending = new Set(existing.pending);
      for (const r of relays) pending.add(r);
      existing.pending = Array.from(pending);
      existing.nextAttemptAt = this.deps.now();
      existing.failed = false; // a fresh publish revives a previously-failed record
      this.persist(existing);
    } else {
      const record: OutboxRecord = {
        eventId,
        pending: Array.from(new Set(relays)),
        attempts: 0,
        nextAttemptAt: this.deps.now(),
        failed: false,
      };
      this.records.set(eventId, record);
      this.persist(record);
    }
    this.deps.onScheduled?.();
  }

  /**
   * A relay just (re)connected — it's demonstrably reachable, so retry anything
   * owed to it immediately, ignoring backoff timing. Skips failed records (they
   * wait for an explicit `retry`).
   */
  flushRelay(relay: string): void {
    for (const record of Array.from(this.records.values())) {
      if (record.failed || this.inFlight.has(record.eventId)) continue;
      if (record.pending.includes(relay)) this.attempt(record, [relay]);
    }
  }

  /** Retry every due record (boot / resume / online / timer). Skips failed ones. */
  sweep(): void {
    const now = this.deps.now();
    for (const record of Array.from(this.records.values())) {
      if (record.failed || this.inFlight.has(record.eventId)) continue;
      if (record.nextAttemptAt <= now) this.attempt(record, record.pending);
    }
  }

  /**
   * Manually re-arm failed records (all, or one by id): clear the failed flag,
   * reset the backoff, and attempt now. The client-facing escape hatch for
   * deliveries that exhausted their automatic retries.
   */
  retry(eventId?: string): void {
    const now = this.deps.now();
    for (const record of Array.from(this.records.values())) {
      if (!record.failed) continue;
      if (eventId !== undefined && record.eventId !== eventId) continue;
      record.failed = false;
      record.attempts = 0;
      record.nextAttemptAt = now;
      this.persist(record);
    }
    this.deps.onScheduled?.();
    this.sweep();
  }

  /** Drop all debt for an event — its store entry is gone (delete/supersede/prune). */
  remove(eventId: string): void {
    if (this.records.delete(eventId)) {
      void this.deps.storage?.deleteOutbox([eventId]);
      this.deps.onScheduled?.();
    }
  }

  /**
   * Earliest `nextAttemptAt` among records NOT currently in flight, or null if
   * there's nothing to schedule. Skipping in-flight records is what stops the
   * owner's timer from busy-looping while an attempt awaits its result.
   */
  earliestNextAttemptAt(): number | null {
    let earliest: number | null = null;
    for (const r of Array.from(this.records.values())) {
      if (r.failed || this.inFlight.has(r.eventId)) continue;
      if (earliest === null || r.nextAttemptAt < earliest) earliest = r.nextAttemptAt;
    }
    return earliest;
  }

  /** Relays still owed across records still being retried (excludes failed). */
  pendingCount(): number {
    let n = 0;
    for (const r of Array.from(this.records.values())) if (!r.failed) n += r.pending.length;
    return n;
  }

  /** Count of records that exhausted automatic retries (awaiting manual retry). */
  failedCount(): number {
    let n = 0;
    for (const r of Array.from(this.records.values())) if (r.failed) n += 1;
    return n;
  }

  /** Read-only snapshot for diagnostics. */
  snapshot(): OutboxRecord[] {
    return Array.from(this.records.values()).map((r) => ({ ...r, pending: [...r.pending] }));
  }

  // --- internals ---

  private attempt(record: OutboxRecord, relays: string[]): void {
    const event = this.deps.getEvent(record.eventId);
    if (!event) {
      this.drop(record.eventId); // store entry vanished (deleted/expired/pruned)
      return;
    }
    this.inFlight.add(record.eventId);
    this.deps.publish(relays, event, (results) => {
      this.inFlight.delete(record.eventId);
      this.applyResults(record, results);
    });
  }

  private applyResults(record: OutboxRecord, results: RelayPublishOutcome[]): void {
    // The record may have been removed (deletion) while the attempt was in flight.
    if (!this.records.has(record.eventId)) return;

    const pending = new Set(record.pending);
    let anyFailed = false;
    for (const r of results) {
      if (r.status === "accepted" || r.status === "rejected") {
        // accepted → it has the event; rejected → it refused, never retry. Both
        // stop us owing this relay.
        pending.delete(r.relay);
      } else {
        anyFailed = true; // timeout / unreachable → still owed
      }
    }
    record.pending = Array.from(pending);

    if (record.pending.length === 0) {
      this.drop(record.eventId); // fully delivered / all relays terminal
      return;
    }
    if (anyFailed) {
      record.attempts += 1;
      if (record.attempts >= this.maxAttempts) {
        // Give up on AUTO-retry but KEEP the record, flagged failed, so the client
        // can list it and trigger a manual retry later (the event stays stored).
        record.failed = true;
      } else {
        record.nextAttemptAt = this.deps.now() + this.backoff(record.attempts);
      }
    }
    this.persist(record);
    this.deps.onScheduled?.();
  }

  private drop(eventId: string): void {
    this.records.delete(eventId);
    void this.deps.storage?.deleteOutbox([eventId]);
    this.deps.onScheduled?.();
  }

  private backoff(attempts: number): number {
    return Math.min(this.max, this.base * 2 ** (attempts - 1));
  }

  private persist(record: OutboxRecord): void {
    void this.deps.storage?.putOutbox([{ ...record, pending: [...record.pending] }]);
  }
}
