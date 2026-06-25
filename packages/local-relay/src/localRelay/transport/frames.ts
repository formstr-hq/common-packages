/**
 * Envelope types for the Worker boundary.
 *
 * Architectural invariant (load-bearing): the main thread can only DECLARE
 * INTERESTS and PUBLISH. It has no verb that means "fetch / open / reconnect /
 * reset" — the worker owns every connection decision based on the union of
 * active interests and its own affordances. So presentation scales independently
 * of the network: registering/dropping interests is the only input, and the
 * worker decides if/when/how to touch relays.
 *
 * The FromWorker `nostr` payload is literal NIP-01 (`RelayMessage`) so the same
 * client code could front a real relay; control frames ride alongside in a
 * tagged envelope.
 */
import type { EventTemplate } from "nostr-tools";
import type { Event, Filter, DBStats } from "../core/types";
import type { ClientMessage, RelayMessage } from "../core/protocol";
import type { RelayPublishOutcome, RelayHealth } from "../sync/RelayPool";

/**
 * A read-only snapshot of the worker's internal state, for debugging. Like
 * `relayHealth`, it's pure observation — reading it never touches the network or
 * mutates anything. Useful for telling a wedged client apart from a wedged
 * worker (e.g. `paused: true` while foregrounded, or `interests: []` while the
 * app still holds observe handles).
 */
export interface Diagnostics {
  /** Lifecycle: true after `pause()`, false after `resume()`. */
  paused: boolean;
  /** Standing interests the app has declared (the worker's only network input). */
  interests: { subId: string; filters: Filter[]; sync: boolean }[];
  /**
   * Live upstream subscriptions (deduped by filter-hash) and the candidate relays
   * each is routed to (author outbox ∪ user relays). A superset of the sockets
   * actually opened, since outbox partitioning may cap per-relay author lists.
   */
  upstream: { filterHash: string; filters: Filter[]; relays: string[] }[];
  /** Per-relay connection health (the same data as `relayHealth()`). */
  relays: RelayHealth[];
  /** The user's NIP-17 DM inbox relays (kind 10050) the kind-1059 stream targets. */
  dmRelays: string[];
  /** The discovered relays currently in the gossip pool (most-recent last). */
  gossipRelays: string[];
  /** Counts of currently-connected relays by source. `outbox` is derived
   *  (connected, but neither a user nor a gossip relay). */
  connections: { user: number; outbox: number; gossip: number; total: number };
  /** Local store statistics (total events, per-kind counts, distinct authors). */
  cache: DBStats;
  /** Pending autonomous-enrichment work. */
  enrichment: { queuedIds: number; queuedAuthors: number; pending: boolean };
}

/** Main thread → Worker. Interests + publish + config/lifecycle only. */
export type ToWorker =
  // --- declarative interests (the ONLY way the app influences reads) ---
  /**
   * Register/replace a standing interest. The worker serves cache + live tail
   * for `subId`, and — unless `sync` is false — autonomously keeps the scope
   * warm from relays (it decides which/when). Re-sending the same `subId` with
   * a wider window is how pagination ("load older") works: still declarative.
   */
  | { kind: "observe"; subId: string; filters: Filter[]; sync: boolean }
  /** Drop a standing interest (worker reconciles its connections). */
  | { kind: "unobserve"; subId: string }
  // --- writes ---
  /** Publish a signed event; worker routes + tracks per-relay outcome. Retry =
   *  publish again (the worker, not the app, handles dead relays). */
  | { kind: "publish"; pubId: string; event: Event }
  /** Add events to the local store without publishing upstream (optimistic). */
  | { kind: "ingest"; events: Event[] }
  // --- config / observation / lifecycle (not network commands) ---
  | { kind: "setAccount"; pubkey: string | null }
  | { kind: "setUserRelays"; relays: string[] }
  /** The user's NIP-17 DM inbox relays (kind 10050) — where the kind-1059 stream
   *  reads. Routing-policy input, kept separate from general read relays. */
  | { kind: "setDmRelays"; relays: string[] }
  /** Add/remove a discovered relay to the gossip pool (read-only discovery —
   *  used to fetch referenced/missing events; never a publish target). */
  | { kind: "addGossipRelay"; url: string }
  | { kind: "removeGossipRelay"; url: string }
  | { kind: "signResult"; reqId: string; event: Event | null }
  | { kind: "relayHealth"; reqId: string }
  /** Ask which relays a stored event has been seen on (provenance). Read-only. */
  | { kind: "seenOn"; reqId: string; eventId: string }
  /** Request a read-only snapshot of the worker's state (debugging only). */
  | { kind: "diagnostics"; reqId: string }
  /** App backgrounded/foregrounded — a lifecycle hint; the worker decides what
   *  to do (it cannot observe page visibility itself). */
  | { kind: "pause" }
  | { kind: "resume" };

/** Worker → main thread. */
export type FromWorker =
  | { kind: "nostr"; msg: RelayMessage }
  | { kind: "signRequest"; reqId: string; template: EventTemplate }
  | { kind: "publishResult"; pubId: string; results: RelayPublishOutcome[] }
  | { kind: "relayHealth"; reqId: string; relays: RelayHealth[] }
  | { kind: "seenOn"; reqId: string; relays: string[] }
  | { kind: "diagnostics"; reqId: string; diagnostics: Diagnostics }
  | { kind: "ready" };

export type { ClientMessage, RelayMessage };
export type { RelayPublishOutcome, RelayHealth };
