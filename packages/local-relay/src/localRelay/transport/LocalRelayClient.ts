/**
 * LocalRelayClient — the main-thread handle to the Worker relay.
 *
 * The API is deliberately interest-only: the app can DECLARE INTERESTS
 * (`observe` / `observeOnce`) and PUBLISH, and nothing else. There is no verb
 * that opens a connection, fetches, reconnects, or resets — the worker owns all
 * of that. This is what lets presentation scale independently of the network.
 *
 * It owns subscription ids, routes incoming frames to callbacks, and answers the
 * worker's NIP-42 sign requests via an injected signer.
 */
import type { Event, Filter } from "../core/types";
import type { EventTemplate } from "nostr-tools";
import { Channel } from "./channel";
import { FromWorker, ToWorker, RelayPublishOutcome, RelayHealth, Diagnostics } from "./frames";

export interface SubscribeHandlers {
  onEvent: (event: Event) => void;
  onEose?: () => void;
}

export interface LocalRelayClientOptions {
  /** Signs NIP-42 AUTH (and any worker-initiated) templates. Returns null to refuse. */
  onSignRequest?: (template: EventTemplate) => Promise<Event | null>;
  /**
   * Grace period before an `unobserve` actually tears the interest down. UI churn
   * routinely drops an interest and re-declares an identical one within the same
   * tick (React StrictMode's mount→cleanup→mount, or a re-render keyed on an async
   * value like the signed-in pubkey resolving). Tearing the upstream down on the
   * drop and rebuilding it on the re-declare loses the in-flight fetch, so a just
   * fetched-and-ingested event fans out to no live subscriber and is silently
   * dropped — a one-shot read then hangs forever. Deferring the teardown by this
   * grace lets the re-declare coalesce onto the SAME still-live upstream. Set 0 to
   * tear down immediately (tests that assert synchronous teardown). Default 1000ms.
   */
  unobserveGraceMs?: number;
}

interface Sub {
  handlers: SubscribeHandlers;
}

export class LocalRelayClient {
  private subs = new Map<string, Sub>();
  private pendingPublishes = new Map<string, (results: RelayPublishOutcome[]) => void>();
  private pendingHealth = new Map<string, (relays: RelayHealth[]) => void>();
  private pendingSeenOn = new Map<string, (relays: string[]) => void>();
  private pendingOnline = new Map<string, (online: boolean) => void>();
  private pendingDiagnostics = new Map<string, (diagnostics: Diagnostics) => void>();
  /** Interests whose teardown is deferred (see `unobserveGraceMs`). */
  private pendingUnobserve = new Map<string, ReturnType<typeof setTimeout>>();
  private counter = 0;
  private readonly unobserveGraceMs: number;

  constructor(private channel: Channel, private opts: LocalRelayClientOptions = {}) {
    this.unobserveGraceMs = opts.unobserveGraceMs ?? 1000;
    channel.onMessage((m) => this.onMessage(m as FromWorker));
  }

  /**
   * Declare a standing interest: the worker replays cache, EOSEs, then streams
   * live updates, and — unless `sync` is false — autonomously keeps the scope
   * warm from relays (its decision, not ours). Re-`observe` the same handle with
   * a wider window to paginate. `localOnly` (sync:false) is a pure store read
   * that triggers no network.
   */
  observe(
    filters: Filter[],
    handlers: SubscribeHandlers,
    options: { localOnly?: boolean; relays?: string[] } = {}
  ): { id: string; update: (filters: Filter[]) => void; unobserve: () => void } {
    const id = `c${this.counter++}`;
    const sync = !options.localOnly;
    const relays = options.relays;
    this.subs.set(id, { handlers });
    this.send({ kind: "observe", subId: id, filters, sync, relays });
    return {
      id,
      update: (next) =>
        this.send({ kind: "observe", subId: id, filters: next, sync, relays }),
      unobserve: () => this.unobserve(id),
    };
  }

  private unobserve(id: string): void {
    if (!this.subs.has(id)) return;
    if (this.pendingUnobserve.has(id)) return;
    if (this.unobserveGraceMs <= 0) {
      this.subs.delete(id);
      this.send({ kind: "unobserve", subId: id });
      return;
    }
    // Defer the real teardown. If the app re-declares an identical interest in the
    // meantime (new subId), reconcile coalesces both onto one still-live upstream,
    // so the in-flight fetch survives the churn. Keep THIS sub's handlers live
    // during the grace so an event already fanned out to it still delivers.
    const timer = setTimeout(() => {
      this.pendingUnobserve.delete(id);
      if (this.subs.delete(id)) this.send({ kind: "unobserve", subId: id });
    }, this.unobserveGraceMs);
    this.pendingUnobserve.set(id, timer);
  }

  /** Add events to the local store without publishing upstream (optimistic/import). */
  ingest(events: Event[]): void {
    if (events.length) this.send({ kind: "ingest", events });
  }

  /**
   * Manually re-attempt delivery of outbox records that exhausted their automatic
   * retries (one event by id, or all failed ones if omitted). The worker re-arms
   * them and tries again — fire-and-forget, like publish.
   */
  retryDelivery(eventId?: string): void {
    this.send({ kind: "retryDelivery", eventId });
  }

  /**
   * Publish an already-signed event; resolves with each relay's outcome (for
   * publish diagnostics). Retry is just another publish — the worker, not the
   * app, decides how to reach dead relays.
   */
  publish(event: Event): Promise<RelayPublishOutcome[]> {
    const pubId = `p${this.counter++}`;
    return new Promise((resolve) => {
      this.pendingPublishes.set(pubId, resolve);
      this.send({ kind: "publish", pubId, event });
    });
  }

  /** Live connection health of the user's relays (read-only observation). */
  relayHealth(): Promise<RelayHealth[]> {
    const reqId = `h${this.counter++}`;
    return new Promise((resolve) => {
      this.pendingHealth.set(reqId, resolve);
      this.send({ kind: "relayHealth", reqId });
    });
  }

  /**
   * Relays a stored event was opportunistically observed on — received upstream
   * on an open subscription, or accepted on publish. Read-only; triggers no
   * network. Usually ONE relay (the source): the worker never re-fetches an event
   * it holds and the pool dedups per subscription, so this is a relay hint, not a
   * "who has it" set. Empty if the event isn't stored or its source is unknown.
   */
  seenOn(eventId: string): Promise<string[]> {
    const reqId = `n${this.counter++}`;
    return new Promise((resolve) => {
      this.pendingSeenOn.set(reqId, resolve);
      this.send({ kind: "seenOn", reqId, eventId });
    });
  }

  /**
   * Whether the worker currently considers itself online — a user relay is
   * connected now, or was within the last 30s (debounced). Derived from real
   * socket state, read-only; triggers no network.
   */
  online(): Promise<boolean> {
    const reqId = `o${this.counter++}`;
    return new Promise((resolve) => {
      this.pendingOnline.set(reqId, resolve);
      this.send({ kind: "online", reqId });
    });
  }

  /** Read-only snapshot of the worker's state (debugging). Triggers no network. */
  diagnostics(): Promise<Diagnostics> {
    const reqId = `d${this.counter++}`;
    return new Promise((resolve) => {
      this.pendingDiagnostics.set(reqId, resolve);
      this.send({ kind: "diagnostics", reqId });
    });
  }

  setActiveAccount(pubkey: string | null): void {
    this.send({ kind: "setAccount", pubkey });
  }

  /** The user's configured relays — a routing-policy input, not a command. */
  setUserRelays(relays: string[]): void {
    this.send({ kind: "setUserRelays", relays });
  }

  /** Dedicated NIP-50 relays — a routing-policy input, not a command. */
  setSearchRelays(relays: string[]): void {
    this.send({ kind: "setSearchRelays", relays });
  }

  /**
   * The user's NIP-17 DM inbox relays (kind 10050) — where their gift-wrapped DMs
   * are delivered. The worker reads the kind-1059 stream from these specifically;
   * general feed reads stay off them. Routing-policy input, not a command.
   */
  setDmRelays(relays: string[]): void {
    this.send({ kind: "setDmRelays", relays });
  }

  /**
   * Add a discovered relay to the worker's gossip pool — used to fetch
   * referenced/missing events (e.g. a note referenced in a DM) from relays the
   * user isn't subscribed to. Read/discovery only; never a publish target.
   */
  addGossipRelay(url: string): void {
    this.send({ kind: "addGossipRelay", url });
  }

  /** Remove a relay from the gossip pool; future fetches stop targeting it. */
  removeGossipRelay(url: string): void {
    this.send({ kind: "removeGossipRelay", url });
  }

  /** App backgrounded — a lifecycle hint; the worker decides what to do. */
  pause(): void {
    this.send({ kind: "pause" });
  }

  /** App foregrounded. */
  resume(): void {
    this.send({ kind: "resume" });
  }

  private send(msg: ToWorker): void {
    this.channel.post(msg);
  }

  private onMessage(m: FromWorker): void {
    if (m.kind === "nostr") {
      const msg = m.msg;
      switch (msg[0]) {
        case "EVENT": {
          this.subs.get(msg[1])?.handlers.onEvent(msg[2]);
          break;
        }
        case "EOSE": {
          this.subs.get(msg[1])?.handlers.onEose?.();
          break;
        }
        case "CLOSED": {
          this.subs.get(msg[1])?.handlers.onEose?.();
          this.subs.delete(msg[1]);
          const timer = this.pendingUnobserve.get(msg[1]);
          if (timer) {
            clearTimeout(timer);
            this.pendingUnobserve.delete(msg[1]);
          }
          break;
        }
        // OK (local store ack) is not surfaced — publish resolves via publishResult.
        // NOTICE: ignored.
      }
      return;
    }

    if (m.kind === "publishResult") {
      const resolve = this.pendingPublishes.get(m.pubId);
      if (resolve) {
        this.pendingPublishes.delete(m.pubId);
        resolve(m.results);
      }
      return;
    }

    if (m.kind === "relayHealth") {
      const resolve = this.pendingHealth.get(m.reqId);
      if (resolve) {
        this.pendingHealth.delete(m.reqId);
        resolve(m.relays);
      }
      return;
    }

    if (m.kind === "seenOn") {
      const resolve = this.pendingSeenOn.get(m.reqId);
      if (resolve) {
        this.pendingSeenOn.delete(m.reqId);
        resolve(m.relays);
      }
      return;
    }

    if (m.kind === "online") {
      const resolve = this.pendingOnline.get(m.reqId);
      if (resolve) {
        this.pendingOnline.delete(m.reqId);
        resolve(m.online);
      }
      return;
    }

    if (m.kind === "diagnostics") {
      const resolve = this.pendingDiagnostics.get(m.reqId);
      if (resolve) {
        this.pendingDiagnostics.delete(m.reqId);
        resolve(m.diagnostics);
      }
      return;
    }

    if (m.kind === "signRequest") {
      const handler = this.opts.onSignRequest;
      Promise.resolve(handler ? handler(m.template) : null)
        .then((event) => this.send({ kind: "signResult", reqId: m.reqId, event }))
        .catch(() => this.send({ kind: "signResult", reqId: m.reqId, event: null }));
      return;
    }
    // "ready": no-op for now.
  }
}
