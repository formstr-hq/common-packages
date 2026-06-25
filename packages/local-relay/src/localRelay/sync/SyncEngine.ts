/**
 * SyncEngine — fills the local relay from real upstream relays. Given a fetch
 * spec (kinds + authors + window), it:
 *   1. partitions authors by their outbox write relays (the gap fix);
 *   2. opens one RelayPool subscription per relay bucket (each carrying only the
 *      authors that publish there) — NOT one giant author list to every relay;
 *   3. verifies signatures, then INGESTs verified events into the relay (batched);
 *   4. aggregates EOSE across every bucket and reports a single combined EOSE
 *      when all buckets are done (RelayPool's per-sub deadline prevents hangs).
 *
 * Pure logic over RelayPool + injected verify/ingest/getWriteRelays → testable
 * end-to-end with FakeSocket, no real network or crypto.
 */
import type { Event, Filter } from "../core/types";
import { verifyEvent } from "nostr-tools";
import { RelayPool } from "./RelayPool";
import { partitionAuthorsByRelay } from "./outbox";

export interface SyncEngineDeps {
  pool: RelayPool;
  /** Insert verified upstream events into the relay (WorkerHost.ingest). */
  ingest: (events: Event[]) => void;
  /** NIP-65 write relays for a pubkey (cache lookup). */
  getWriteRelays: (pubkey: string) => string[];
  /** Signature verification; defaults to nostr-tools verifyEvent. */
  verify?: (event: Event) => boolean;
  /** Record which relay an ingested event was seen on (provenance). */
  recordSeen?: (eventId: string, relay: string) => void;
}

export interface FetchSpec {
  kinds: number[];
  authors: string[];
  userRelays: string[];
  since?: number;
  until?: number;
  limit?: number;
  eoseDeadlineMs?: number;
}

export interface SyncHandle {
  close(): void;
}

const FLUSH_MS = 50;

export class SyncEngine {
  private verify: (event: Event) => boolean;

  constructor(private deps: SyncEngineDeps) {
    this.verify = deps.verify ?? defaultVerify;
  }

  /**
   * Open an outbox-partitioned fetch. Stays live (streaming + ingesting) until
   * `close()`. `onEose` fires once when every relay bucket has completed.
   */
  fetch(spec: FetchSpec, onEose?: () => void): SyncHandle {
    const plan = partitionAuthorsByRelay(spec.authors, spec.userRelays, this.deps.getWriteRelays);

    const buckets = Array.from(plan.entries()).filter(([, authors]) => authors.size > 0);
    if (buckets.length === 0) {
      onEose?.();
      return { close() {} };
    }

    const subIds: string[] = [];
    let buffer: { event: Event; relay: string }[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    let eosedBuckets = 0;
    let combinedEosed = false;

    const flush = () => {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      this.deps.ingest(batch.map((e) => e.event));
      // Record provenance after ingest, so recordSeen sees the stored event.
      if (this.deps.recordSeen) {
        for (const { event, relay } of batch) this.deps.recordSeen(event.id, relay);
      }
    };
    const scheduleFlush = () => {
      if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
    };

    const onBucketEose = () => {
      eosedBuckets++;
      if (eosedBuckets >= buckets.length && !combinedEosed) {
        combinedEosed = true;
        flush(); // make sure everything is ingested before signalling EOSE
        onEose?.();
      }
    };

    for (const [relay, authorSet] of buckets) {
      const filter: Filter = { kinds: spec.kinds, authors: Array.from(authorSet) };
      if (spec.since !== undefined) filter.since = spec.since;
      if (spec.until !== undefined) filter.until = spec.until;
      if (spec.limit !== undefined) filter.limit = spec.limit;

      const id = this.deps.pool.subscribe(
        [relay],
        [filter],
        {
          onEvent: (event, relay) => {
            if (!this.verify(event)) return; // drop forged/garbage
            buffer.push({ event, relay });
            scheduleFlush();
          },
          onEose: onBucketEose,
        },
        { eoseDeadlineMs: spec.eoseDeadlineMs }
      );
      subIds.push(id);
    }

    return {
      close: () => {
        if (flushTimer) clearTimeout(flushTimer);
        flush();
        for (const id of subIds) this.deps.pool.unsubscribe(id);
      },
    };
  }
}

export function defaultVerify(event: Event): boolean {
  // nostr-tools is a hard dependency of this package; tests bypass this entirely
  // by injecting their own `verify` via SyncEngineDeps.
  return verifyEvent(event as any);
}
