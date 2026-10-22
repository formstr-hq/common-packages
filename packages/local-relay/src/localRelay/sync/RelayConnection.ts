/**
 * RelayConnection — a single upstream relay. Owns one Socket, speaks NIP-01,
 * survives drops with exponential backoff + jitter, and resubscribes active REQs
 * on reconnect. Pure logic over the Socket interface → fully testable with
 * FakeSocket.
 *
 * It does NOT verify signatures or store events — it just parses frames and
 * forwards them to the pool. Verification + storage happen above (SyncEngine →
 * RelayCore.ingest), keeping this layer crypto-free.
 *
 * NIP-42 AUTH: a relay may answer a REQ with an `AUTH` challenge and then serve
 * nothing until we authenticate (some send `CLOSED <sub> auth-required`, some
 * just go quiet). When `onAuth` is supplied this connection builds the kind-22242
 * template (bound to this relay's URL + the challenge), asks the host to sign
 * it, replies `["AUTH", event]`, and — once the relay has ACCEPTED that AUTH —
 * re-issues every active REQ, since the ones sent before the challenge were not
 * honoured. Without `onAuth` the challenge is ignored, which is the correct
 * behavior for a relay that never challenges.
 *
 * The replay is deliberately NOT back-to-back with the AUTH frame: a relay
 * verifies the AUTH signature asynchronously and rejects a REQ that arrives
 * before that check finishes (observed on relay.formstr.app, where an immediate
 * replay is still answered `CLOSED auth-required`). We therefore wait for the
 * AUTH `OK true` — with a short grace timeout as a fallback for relays that
 * don't acknowledge AUTH — and replay then. An explicit `OK false` cancels it.
 */
import type { Event, Filter } from "../core/types";
import type { EventTemplate } from "nostr-tools";

export interface RelayConnectionHandlers {
  onEvent: (subId: string, event: Event, relay: string) => void;
  /** Socket reached OPEN (initial connect or a reconnect). */
  onConnect?: (relay: string) => void;
  /** Relay signalled end-of-stored-events for this sub. */
  onEose: (subId: string, relay: string) => void;
  /** Relay closed this sub (e.g. auth-required) — counts as "done" upstream. */
  onClosed: (subId: string, relay: string, message: string) => void;
  onOk?: (eventId: string, ok: boolean, message: string, relay: string) => void;
  /**
   * Sign a NIP-42 AUTH template (kind 22242, tagged with this relay's URL and
   * the relay's challenge). Return the signed event, or null to refuse — a
   * refusal (no signer, user denied) leaves the relay unauthenticated, exactly
   * as if the hook were absent.
   */
  onAuth?: (template: EventTemplate) => Promise<Event | null>;
}

export interface RelayConnectionOptions {
  autoReconnect?: boolean;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Max REQs open on this socket at once; the rest wait in a queue (where
   * compatible lookups merge). Lowered automatically when the relay says
   * "too many subscriptions" (to the relay's stated number when it gives one).
   * Default 30.
   */
  maxSubscriptions?: number;
  /**
   * Max REQs sent but not yet finished (no EOSE) at once. This is what most
   * "too many concurrent REQs" relays limit — some block the connection outright
   * when a burst exceeds it. Lowered automatically (to 4 at least) when a relay
   * says "too many concurrent REQs". Default 24.
   */
  maxInFlight?: number;
  /** Sustained REQ rate per socket (token bucket refill). Default 20/s. */
  reqsPerSecond?: number;
  /**
   * Token bucket size: REQs that may go out back-to-back. Default 40, so a cold
   * start (every feed + profile lookup at once) isn't throttled from the first
   * second; relays that object get paced down by the pushback handling.
   */
  reqBurst?: number;
  /** Largest array (authors/ids/#e…) sent in one filter; bigger ones split. Default 300. */
  maxFilterItems?: number;
  /** Largest REQ frame in bytes; bigger ones split. Default 60_000. */
  maxReqBytes?: number;
  /**
   * A socket must stay open this long before reconnect backoff resets, so a relay
   * that accepts then immediately kicks us is not re-dialled in a tight loop.
   */
  stableConnectionMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/** A REQ as sent on this socket. One wire REQ may serve several logical subs. */
interface WireReq {
  id: string;
  filters: Filter[];
  /** Logical sub id → that sub's own filters (used to route merged results). */
  members: Map<string, Filter[]>;
  /** queued: waiting for a slot · open: on the wire · parked: closed
   *  auth-required · dormant: resumable but its window is over (`until` past). */
  state: "queued" | "open" | "parked" | "dormant";
  merge: MergeInfo | null;
  /** Pushback retries, so a relay that always refuses can't loop forever. */
  retries: number;
  /** Background work (enrichment) waits behind everything the app asked for. */
  low: boolean;
  /** When this REQ last went on the wire, and when it first reached EOSE. */
  openedAt: number;
  eosedAt: number | null;
  /**
   * Set when a caught-up REQ was closed to free its slot (rotation) or by a
   * reconnect: it is re-sent with `since` this (unix seconds) so it catches up
   * without re-downloading its history.
   */
  resumeSince: number | null;
}

/** A subscription as the pool sees it; may span several wire REQs. */
interface LogicalSub {
  wires: Set<string>;
  done: Set<string>;
  eosed: boolean;
}

const MAX_PUSHBACK_RETRIES = 5;
/**
 * A caught-up REQ must have been open this long before it can be rotated out to
 * free a slot. Bounds rotation churn (and back-and-forth swapping) to one per
 * slot per this interval.
 */
const ROTATE_MIN_OPEN_MS = 20_000;
/**
 * During a connection's first moments (a cold start: every feed, profile and
 * list lookup at once) rotation is allowed after only this long, so first paint
 * isn't stuck behind long-lived subs; afterwards ROTATE_MIN_OPEN_MS applies.
 */
const ROTATE_COLD_MIN_OPEN_MS = 5_000;
const COLD_START_MS = 30_000;
/**
 * When the one waiting is itself a rotated sub (more long-lived subs than slots),
 * they share slots on this slower cycle instead of swapping every few seconds.
 */
const ROTATE_SHARE_MS = 30_000;
/** Floor for the adaptive REQ pacing after rate-limits. */
const MIN_REQS_PER_SECOND = 2;
/** Floor for the adaptive loading-REQ limit. */
const MIN_IN_FLIGHT = 4;
/** A REQ with no EOSE after this long stops counting as in flight. */
const IN_FLIGHT_TIMEOUT_MS = 8_000;
/** Overlap when resuming with `since`, for events that arrive slightly late. */
const RESUME_SLACK_S = 60;
/**
 * Floor and ceiling for a rate-limit pause. Relays typically ask for 1–2s; a
 * long pause starves every feed that relay serves, so escalation stays modest.
 */
const MIN_COOLDOWN_MS = 1000;
const MAX_COOLDOWN_MS = 15_000;
/** Rate-limit strikes are forgotten after this long without a new one. */
const STRIKE_DECAY_MS = 30_000;

import type { Socket, SocketFactory } from "./Socket";
import { matchAnyFilter } from "../core/matchFilter";
import {
  MergeInfo,
  classifyPushback,
  combineFilters,
  mergeInfo,
  mergedSize,
  splitFilters,
  halveFilter,
} from "./reqShaping";

/**
 * How long to wait for an `OK` for our AUTH event before replaying the active
 * REQs anyway. The `OK true` is the reliable trigger; this is a ceiling for
 * relays that authenticate without acknowledging, so a sub can't hang forever.
 */
export const AUTH_REPLAY_GRACE_MS = 600;

export class RelayConnection {
  private socket: Socket | null = null;
  private sendQueue: unknown[] = [];
  /** REQs on (or waiting for) this socket, by wire sub id. */
  private wires = new Map<string, WireReq>();
  /** Wire ids waiting for a slot, in send order. */
  private queue: string[] = [];
  /** Queued, still-mergeable wire REQs by merge key. */
  private mergeTargets = new Map<string, string>();
  private logical = new Map<string, LogicalSub>();
  private wireCounter = 0;
  /** Current cap on open REQs (starts at maxSubscriptions, lowered on pushback). */
  private subCap: number;
  /** Current cap on loading REQs (starts at maxInFlight, lowered on pushback). */
  private inFlightCap: number;
  /** Current REQ pacing (starts at reqsPerSecond, halved on rate-limits). */
  private reqRate: number;
  private tokens: number;
  private tokensAt: number;
  /** No REQs go out before this time (relay asked us to slow down). */
  private pausedUntil = 0;
  private strikes = 0;
  private lastStrikeAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wire REQ most recently sent — the likely culprit of an untargeted NOTICE. */
  private lastSentWire: string | null = null;
  private openedAt = 0;
  private backoffAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUs = false;
  private readonly opts: Required<RelayConnectionOptions>;
  /**
   * The challenge currently being signed for this socket, and whether a sign is
   * in flight. A relay may re-challenge; we sign once per distinct challenge and
   * never two concurrently. Cleared on every (re)connect — a new socket needs a
   * fresh AUTH even for the same string.
   */
  private authChallenge: string | null = null;
  private authInFlight = false;
  /**
   * The id of the AUTH event we are waiting on an `OK` for. Set when we write
   * `["AUTH", event]`; on `OK true` we replay the active REQs, on `OK false` we
   * abandon the attempt. Cleared by `fireAuthReplay` and on (re)connect.
   */
  private pendingAuthEventId: string | null = null;
  /**
   * Fallback timer that replays the active REQs if the relay never answers the
   * AUTH with an `OK`. Some relays authenticate silently, and without this the
   * subs would hang in `auth-required` forever.
   */
  private authReplayTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly url: string,
    private factory: SocketFactory,
    private handlers: RelayConnectionHandlers,
    options: RelayConnectionOptions = {}
  ) {
    this.opts = {
      autoReconnect: options.autoReconnect ?? true,
      baseBackoffMs: options.baseBackoffMs ?? 1000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      maxSubscriptions: options.maxSubscriptions ?? 30,
      maxInFlight: options.maxInFlight ?? 24,
      reqsPerSecond: options.reqsPerSecond ?? 20,
      reqBurst: options.reqBurst ?? 40,
      maxFilterItems: options.maxFilterItems ?? 300,
      maxReqBytes: options.maxReqBytes ?? 60_000,
      stableConnectionMs: options.stableConnectionMs ?? 10_000,
      now: options.now ?? (() => Date.now()),
    };
    this.subCap = this.opts.maxSubscriptions;
    this.inFlightCap = this.opts.maxInFlight;
    this.reqRate = this.opts.reqsPerSecond;
    this.tokens = this.opts.reqBurst;
    this.tokensAt = this.opts.now();
  }

  /** Queue/throttle state for diagnostics. */
  get stats(): {
    open: number;
    inFlight: number;
    inFlightCap: number;
    reqRate: number;
    queued: number;
    cap: number;
    pausedUntil: number;
  } {
    return {
      open: this.openCount(),
      inFlight: this.inFlightCount(this.opts.now()),
      inFlightCap: this.inFlightCap,
      reqRate: this.reqRate,
      queued: this.queue.length,
      cap: this.subCap,
      pausedUntil: this.pausedUntil,
    };
  }

  get connected(): boolean {
    return this.socket?.readyState === 1;
  }

  /** Socket exists and is still in the CONNECTING handshake. */
  get connecting(): boolean {
    return this.socket?.readyState === 0;
  }

  /** Waiting on a backoff timer to reconnect after a drop. */
  get reconnecting(): boolean {
    return this.reconnectTimer !== null;
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.closedByUs = false;
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.onopen = () => {
      this.openedAt = this.opts.now();
      // A fresh socket must authenticate afresh; the relay will re-challenge.
      this.authChallenge = null;
      this.authInFlight = false;
      this.pendingAuthEventId = null;
      if (this.authReplayTimer) {
        clearTimeout(this.authReplayTimer);
        this.authReplayTimer = null;
      }
      // Resubscribe everything that was active before the (re)connect — through
      // the queue, open ones first, so a reconnect is not a burst of every REQ.
      const reopen = Array.from(this.wires.values()).filter(
        (w) => w.state === "open" || w.state === "parked",
      );
      for (const w of reopen) w.state = "queued";
      this.queue = [...reopen.map((w) => w.id), ...this.queue.filter((id) => !reopen.some((w) => w.id === id))];
      this.pump();
      // Flush anything queued while connecting.
      const queued = this.sendQueue;
      this.sendQueue = [];
      for (const msg of queued) this.write(msg);
      // Signal reachability last, so listeners (outbox flush, online tracking)
      // run after queued REQs/publishes are already on the wire.
      this.handlers.onConnect?.(this.url);
    };
    socket.onmessage = (data) => this.onMessage(data);
    socket.onclose = () => this.onDrop();
    socket.onerror = () => {
      /* close handler drives reconnect; error alone is informational */
    };
  }

  req(subId: string, filters: Filter[], opts: { low?: boolean } = {}): void {
    const low = !!opts.low;
    if (this.logical.has(subId)) this.close(subId);
    const sub: LogicalSub = { wires: new Set(), done: new Set(), eosed: false };
    this.logical.set(subId, sub);

    const parts = splitFilters(filters, this.opts.maxFilterItems, this.opts.maxReqBytes);
    const info = parts.length === 1 ? mergeInfo(filters) : null;

    // Ride along on a queued REQ for the same thing, if one is waiting.
    if (info) {
      const targetId = this.mergeTargets.get(info.key);
      const target = targetId ? this.wires.get(targetId) : undefined;
      if (
        target &&
        target.state === "queued" &&
        target.low === low &&
        mergedSize([...target.members.values()].flat().concat(filters), info) <=
          this.opts.maxFilterItems
      ) {
        target.members.set(subId, filters);
        target.filters = [combineFilters([...target.members.values()].flat(), info)];
        sub.wires.add(target.id);
        return;
      }
    }

    parts.forEach((partFilters, i) => {
      const id = this.newWireId(i === 0 ? subId : `${subId}:${i}`);
      const wire: WireReq = {
        id,
        filters: partFilters,
        members: new Map([[subId, partFilters]]),
        state: "queued",
        merge: info,
        retries: 0,
        low,
        openedAt: 0,
        eosedAt: null,
        resumeSince: null,
      };
      this.wires.set(id, wire);
      this.enqueueWire(wire);
      sub.wires.add(id);
      if (info) this.mergeTargets.set(info.key, id);
    });
    this.pump();
  }

  close(subId: string): void {
    const sub = this.logical.get(subId);
    if (!sub) return;
    this.logical.delete(subId);
    for (const wireId of Array.from(sub.wires)) {
      const wire = this.wires.get(wireId);
      if (!wire) continue;
      wire.members.delete(subId);
      if (wire.members.size > 0) {
        // Still serving other subs. If it hasn't gone out yet, shrink it to
        // just what they need.
        if (wire.state === "queued" && wire.merge)
          wire.filters = [combineFilters([...wire.members.values()].flat(), wire.merge)];
        continue;
      }
      this.dropWire(wire);
    }
    this.pump();
  }  publish(event: Event): void {
    this.enqueue(["EVENT", event]);
  }

  /** Permanently close this connection (no reconnect). */
  destroy(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authReplayTimer) {
      clearTimeout(this.authReplayTimer);
      this.authReplayTimer = null;
    }
    this.pendingAuthEventId = null;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    this.wires.clear();
    this.queue = [];
    this.mergeTargets.clear();
    this.logical.clear();
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
  }

  /** Queue non-REQ messages (publishes) until the socket is open. REQs do NOT
   * use this path — they go through the REQ queue (see `pump`). */
  private enqueue(msg: unknown): void {
    if (this.connected) {
      this.write(msg);
    } else {
      this.sendQueue.push(msg);
      this.connect();
    }
  }

  private write(msg: unknown): void {
    try {
      this.socket?.send(JSON.stringify(msg));
    } catch {
      // Send failed — queue for the next open and let reconnect handle it.
      this.sendQueue.push(msg);
    }
  }

  private onMessage(data: string): void {
    let msg: any[];
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!Array.isArray(msg)) return;
    switch (msg[0]) {
      case "EVENT":
        this.routeEvent(msg[1], msg[2]);
        break;
      case "EOSE":
        this.onWireEose(msg[1]);
        break;
      case "CLOSED":
        this.onWireClosed(msg[1], msg[2] ?? "");
        break;
      case "NOTICE":
        this.onNotice(String(msg[1] ?? ""));
        break;
      case "OK":
        // The relay accepted/refused an event we published. If it's our AUTH
        // event, this is the point at which the relay is genuinely authenticated
        // — only now is a REQ replay safe (see `authenticate`).
        if (this.pendingAuthEventId && msg[1] === this.pendingAuthEventId) {
          if (msg[2]) this.fireAuthReplay();
          else this.cancelAuthReplay();
        }
        this.handlers.onOk?.(msg[1], !!msg[2], msg[3] ?? "", this.url);
        break;
      case "AUTH":
        void this.authenticate(String(msg[1] ?? ""));
        break;
    }
  }

  /**
   * Answer a NIP-42 challenge: sign kind 22242 and, once the relay accepts the
   * AUTH, re-issue every active REQ.
   *
   * REQs sent before the challenge are not honoured by the relay, so the
   * resubscribe after AUTH is what actually starts the data flowing — but it
   * must wait for the relay to register the AUTH. Signing is async; the relay
   * also verifies the AUTH asynchronously. We therefore write `["AUTH", event]`
   * and defer the replay until either the matching `OK true` arrives (the
   * reliable signal) or a short grace timeout fires (relays that authenticate
   * silently). A refusal or missing hook is not an error — the relay simply
   * stays unauthenticated, and its CLOSED/deadline handling treats it as done.
   */
  private async authenticate(challenge: string): Promise<void> {
    if (!this.handlers.onAuth || !challenge) return;
    // Never sign two challenges concurrently, and never re-sign one we have
    // already answered on this socket (a relay may re-send AUTH at any time).
    if (this.authInFlight || this.authChallenge === challenge) return;
    this.authChallenge = challenge;
    this.authInFlight = true;
    // Capture the socket this challenge belongs to. Signing is async; if the
    // socket drops and is replaced while we wait, the resolved event must be
    // discarded rather than written to the NEW socket — its challenge differs,
    // and AUTHing it with a stale challenge leaves it unauthenticated.
    const socket = this.socket;
    try {
      const template: EventTemplate = {
        kind: 22242,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
        ],
        content: "",
      };
      const event = await this.handlers.onAuth(template);
      // Refused, or the socket died/was replaced while we were signing — either
      // way, do not authenticate a stale socket.
      if (!event || this.socket !== socket || !this.connected) return;
      this.pendingAuthEventId = event.id;
      this.write(["AUTH", event]);
      // Fallback for relays that authenticate silently (no `OK`): replay after a
      // short grace. The `OK true` path cancels this and replays immediately.
      this.authReplayTimer = setTimeout(() => this.fireAuthReplay(), AUTH_REPLAY_GRACE_MS);
    } catch {
      // A throwing signer must not break the connection; stay unauthenticated.
    } finally {
      this.authInFlight = false;
    }
  }

  /**
   * The relay has registered our AUTH (or the grace window elapsed): replay every
   * active REQ on the authenticated socket. Idempotent — safe to call from both
   * the `OK` handler and the grace timer. `pendingAuthEventId` is intentionally
   * NOT cleared here: if the relay's `OK` lands after the grace timer, the `OK`
   * handler replays again on a now-genuinely-authenticated socket.
   */
  private fireAuthReplay(): void {
    if (this.authReplayTimer) {
      clearTimeout(this.authReplayTimer);
      this.authReplayTimer = null;
    }
    if (!this.connected) return;
    // Open REQs are re-sent in place (same id: the relay replaces them, so the
    // slot count is unchanged); ones the relay closed as auth-required go back
    // to the front of the queue.
    const parked: string[] = [];
    for (const wire of Array.from(this.wires.values())) {
      if (wire.state === "open") {
        const filters = this.wireFilters(wire);
        if (filters) this.write(["REQ", wire.id, ...filters]);
      }
      else if (wire.state === "parked") {
        wire.state = "queued";
        parked.push(wire.id);
      }
    }
    this.queue = [...parked, ...this.queue];
    this.pump();
  }

  /** The relay refused our AUTH — give up on this attempt without replaying. */
  private cancelAuthReplay(): void {
    this.pendingAuthEventId = null;
    if (this.authReplayTimer) {
      clearTimeout(this.authReplayTimer);
      this.authReplayTimer = null;
    }
  }

  private onDrop(): void {
    // Caught-up REQs resume from (about) now on the next socket instead of
    // re-downloading everything they already delivered.
    const resumeAt = Math.floor(this.opts.now() / 1000) - RESUME_SLACK_S;
    for (const w of this.wires.values()) {
      if (w.state === "open" && w.eosedAt !== null) w.resumeSince = resumeAt;
    }
    // Only a connection that stayed up counts as healthy; one the relay kicked
    // right after accepting keeps escalating the backoff.
    if (this.openedAt && this.opts.now() - this.openedAt >= this.opts.stableConnectionMs)
      this.backoffAttempts = 0;
    this.openedAt = 0;
    this.socket = null;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    if (this.closedByUs || !this.opts.autoReconnect) return;
    const delay = this.nextBackoff();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // --- REQ queue ------------------------------------------------------------

  private newWireId(preferred: string): string {
    if (!this.wires.has(preferred)) return preferred;
    let id: string;
    do id = `${preferred}~${this.wireCounter++}`;
    while (this.wires.has(id));
    return id;
  }

  /** Queue a new wire REQ: app requests ahead of any background (low) ones. */
  private enqueueWire(wire: WireReq): void {
    if (wire.low) {
      this.queue.push(wire.id);
      return;
    }
    const firstLow = this.queue.findIndex((id) => this.wires.get(id)?.low);
    if (firstLow === -1) this.queue.push(wire.id);
    else this.queue.splice(firstLow, 0, wire.id);
  }

  /** REQs still loading (sent, no EOSE yet, not given up on). */
  private inFlightCount(now: number): number {
    let n = 0;
    for (const w of this.wires.values())
      if (w.state === "open" && w.eosedAt === null && now - w.openedAt < IN_FLIGHT_TIMEOUT_MS) n++;
    return n;
  }

  /** When the oldest in-flight REQ times out of the in-flight count. */
  private nextInFlightExpiry(): number | null {
    let at: number | null = null;
    for (const w of this.wires.values()) {
      if (w.state !== "open" || w.eosedAt !== null) continue;
      const t = w.openedAt + IN_FLIGHT_TIMEOUT_MS;
      if (at === null || t < at) at = t;
    }
    return at;
  }

  private openCount(): number {
    let n = 0;
    for (const w of this.wires.values()) if (w.state === "open") n++;
    return n;
  }

  /** Remove a wire REQ entirely, telling the relay if it was on the wire. */
  private dropWire(wire: WireReq): void {
    if (wire.state === "open" && this.connected) this.write(["CLOSE", wire.id]);
    this.unqueue(wire);
    this.wires.delete(wire.id);
    if (this.lastSentWire === wire.id) this.lastSentWire = null;
  }

  private unqueue(wire: WireReq): void {
    const i = this.queue.indexOf(wire.id);
    if (i !== -1) this.queue.splice(i, 1);
    if (wire.merge && this.mergeTargets.get(wire.merge.key) === wire.id)
      this.mergeTargets.delete(wire.merge.key);
  }

  private refillTokens(now: number): void {
    const elapsed = now - this.tokensAt;
    this.tokensAt = now;
    this.tokens = Math.min(
      this.opts.reqBurst,
      this.tokens + (elapsed / 1000) * this.reqRate,
    );
  }

  /** Send queued REQs while there are free slots, tokens, and no pause. */
  private pump(): void {
    if (!this.queue.length) return;
    if (!this.connected) {
      if (!this.connecting && !this.reconnecting) this.connect();
      return;
    }
    const now = this.opts.now();
    if (now < this.pausedUntil) return this.schedulePump(this.pausedUntil - now);
    this.refillTokens(now);
    while (this.queue.length) {
      if (this.openCount() >= this.subCap && !this.rotateOne(now)) {
        // Full, and nothing caught-up is old enough to rotate yet — retry then.
        const next = this.nextRotationAt();
        if (next !== null) this.schedulePump(next - now);
        return;
      }
      if (this.inFlightCount(now) >= this.inFlightCap) {
        // An EOSE re-pumps; the timeout covers a relay that never answers.
        const expiry = this.nextInFlightExpiry();
        if (expiry !== null) this.schedulePump(expiry - now);
        return;
      }
      if (this.tokens < 1) {
        return this.schedulePump(((1 - this.tokens) / this.reqRate) * 1000);
      }
      const wire = this.wires.get(this.queue[0])!;
      this.unqueue(wire);
      const filters = this.wireFilters(wire);
      if (!filters) {
        wire.state = "dormant"; // its window is over; nothing new can arrive
        continue;
      }
      this.tokens -= 1;
      wire.state = "open";
      wire.openedAt = now;
      this.lastSentWire = wire.id;
      this.write(["REQ", wire.id, ...filters]);
    }
  }

  /**
   * The filters to send for a wire REQ: as-is, or — when resuming a caught-up
   * REQ — narrowed with `since`. Null if every filter's window has already
   * closed (`until` before the resume point), i.e. nothing is left to receive.
   */
  private wireFilters(wire: WireReq): Filter[] | null {
    if (wire.resumeSince === null) return wire.filters;
    const since = wire.resumeSince;
    const out: Filter[] = [];
    for (const f of wire.filters) {
      if (f.until !== undefined && f.until < since) continue;
      out.push({ ...f, since: Math.max(f.since ?? 0, since) });
    }
    return out.length ? out : null;
  }

  /** How long a caught-up REQ must have been open to give its slot to `head`. */
  private rotateAfterMs(head: WireReq | undefined): number {
    if (head && head.resumeSince !== null) return ROTATE_SHARE_MS;
    const cold = this.openedAt > 0 && this.opts.now() - this.openedAt < COLD_START_MS;
    return cold ? ROTATE_COLD_MIN_OPEN_MS : ROTATE_MIN_OPEN_MS;
  }

  /** Is this open REQ caught up (EOSE seen) and old enough to give up its slot? */
  private rotatable(wire: WireReq, now: number, minOpenMs: number): boolean {
    return (
      wire.state === "open" &&
      !wire.low &&
      wire.eosedAt !== null &&
      now - wire.openedAt >= minOpenMs
    );
  }

  /**
   * Free a slot for the queue head by closing the longest-open caught-up REQ;
   * it re-queues behind what's already waiting and resumes with `since`.
   * This also runs when the head is itself a rotated REQ — refusing then would
   * stall the relay's whole queue once every slot holds a long-lived sub — but
   * then only on the slower ROTATE_SHARE_MS cycle, so oversubscribed long-lived
   * subs take turns instead of churning.
   */
  private rotateOne(now: number): boolean {
    if (!this.queue.length) return false;
    const minOpen = this.rotateAfterMs(this.wires.get(this.queue[0]));
    let victim: WireReq | null = null;
    for (const w of this.wires.values()) {
      if (this.rotatable(w, now, minOpen) && (!victim || w.openedAt < victim.openedAt)) victim = w;
    }
    if (!victim) return false;
    this.write(["CLOSE", victim.id]);
    victim.state = "queued";
    victim.resumeSince = Math.floor(now / 1000) - RESUME_SLACK_S;
    this.enqueueWire(victim);
    return true;
  }

  /** When the next caught-up REQ becomes rotatable, if any. */
  private nextRotationAt(): number | null {
    let at: number | null = null;
    for (const w of this.wires.values()) {
      if (w.state !== "open" || w.low || w.eosedAt === null) continue;
      const t = w.openedAt + this.rotateAfterMs(this.wires.get(this.queue[0]));
      if (at === null || t < at) at = t;
    }
    return at;
  }

  private schedulePump(delayMs: number): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, Math.max(0, Math.ceil(delayMs)));
  }

  /** Put an open wire REQ back at the front of the queue (it was refused). */
  private requeue(wire: WireReq): void {
    wire.retries++;
    if (wire.state === "open" && this.connected) this.write(["CLOSE", wire.id]);
    wire.state = "queued";
    if (!this.queue.includes(wire.id)) this.queue.unshift(wire.id);
  }

  /** Replace a refused wire REQ with smaller ones, or null if it can't shrink. */
  private splitWire(wire: WireReq): boolean {
    if (wire.filters.length !== 1) return false;
    const halves = halveFilter(wire.filters[0]);
    if (!halves) return false;
    if (wire.state === "open" && this.connected) this.write(["CLOSE", wire.id]);
    this.unqueue(wire);
    this.wires.delete(wire.id);
    const ids: string[] = [];
    for (const half of halves) {
      const id = this.newWireId(`${wire.id}.`);
      // Each half keeps every member; the members' own filters route results.
      this.wires.set(id, {
        id,
        filters: [half],
        members: new Map(wire.members),
        state: "queued",
        merge: null,
        retries: wire.retries + 1,
        low: wire.low,
        openedAt: 0,
        eosedAt: null,
        resumeSince: wire.resumeSince,
      });
      ids.push(id);
    }
    for (const memberId of wire.members.keys()) {
      const sub = this.logical.get(memberId);
      if (!sub) continue;
      sub.wires.delete(wire.id);
      sub.done.delete(wire.id);
      for (const id of ids) sub.wires.add(id);
    }
    this.queue = [...ids, ...this.queue];
    return true;
  }

  /** Split a wire REQ the relay already closed (so no CLOSE is sent for it). */
  private splitInPlace(wire: WireReq): boolean {
    const was = wire.state;
    wire.state = "queued";
    if (this.splitWire(wire)) return true;
    wire.state = was;
    return false;
  }

  /**
   * React to "too many": a stated number becomes the cap; otherwise back off
   * just below the current level — the loading-REQ limit for the "concurrent"
   * wording, the open-subscription cap otherwise.
   */
  private applySubLimit(push: { limit?: number; concurrent?: boolean }): void {
    const now = this.opts.now();
    // A stated limit keeps one in reserve: a CLOSE and the REQ replacing it can
    // race on the relay's side, which at exactly the limit is a rejection.
    const stated = push.limit !== undefined ? Math.max(1, push.limit - 1) : undefined;
    if (push.concurrent) {
      const current = stated ?? this.inFlightCount(now) - 1;
      this.inFlightCap = Math.max(MIN_IN_FLIGHT, Math.min(this.inFlightCap, current));
    } else {
      const current = stated ?? this.openCount() - 1;
      this.subCap = Math.max(1, Math.min(this.subCap, current));
    }
  }

  /** A relay said "too many messages": pace this socket slower from now on. */
  private slowDown(): void {
    this.reqRate = Math.max(MIN_REQS_PER_SECOND, this.reqRate / 2);
  }

  /** Pause REQs to this relay, escalating on repeated pushback. */
  private cooldown(retryMs?: number): void {
    const now = this.opts.now();
    if (now - this.lastStrikeAt > STRIKE_DECAY_MS) this.strikes = 0;
    this.strikes++;
    this.lastStrikeAt = now;
    const escalated = MIN_COOLDOWN_MS * 1.5 ** (this.strikes - 1);
    const wait = Math.min(MAX_COOLDOWN_MS, Math.max(MIN_COOLDOWN_MS, retryMs ?? 0, escalated));
    this.pausedUntil = Math.max(this.pausedUntil, now + wait);
  }

  private routeEvent(wireId: string, event: Event): void {
    const wire = this.wires.get(wireId);
    if (!wire) return;
    if (wire.members.size === 1) {
      const [memberId] = wire.members.keys();
      this.handlers.onEvent(memberId, event, this.url);
      return;
    }
    // Merged REQ: hand each sub only the events its own filters ask for.
    for (const [memberId, filters] of wire.members) {
      if (matchAnyFilter(event, filters)) this.handlers.onEvent(memberId, event, this.url);
    }
  }

  /** A wire REQ finished; a logical sub is done once all its wire REQs are. */
  private finishWire(wire: WireReq, closedMessage?: string): void {
    for (const memberId of Array.from(wire.members.keys())) {
      const sub = this.logical.get(memberId);
      if (!sub) continue;
      sub.done.add(wire.id);
      if (closedMessage !== undefined) {
        this.handlers.onClosed(memberId, this.url, closedMessage);
      } else if (!sub.eosed && Array.from(sub.wires).every((id) => sub.done.has(id))) {
        sub.eosed = true;
        this.handlers.onEose(memberId, this.url);
      }
    }
  }

  private onWireEose(wireId: string): void {
    const wire = this.wires.get(wireId);
    if (!wire) return;
    if (wire.eosedAt === null) wire.eosedAt = this.opts.now();
    this.finishWire(wire);
    // A caught-up REQ may now be rotatable for something waiting.
    if (this.queue.length) this.pump();
  }

  private onWireClosed(wireId: string, message: string): void {
    const wire = this.wires.get(wireId);
    if (!wire) return;
    const push = classifyPushback(message);
    const retryable = wire.retries < MAX_PUSHBACK_RETRIES;
    if (push.type === "auth-required") {
      // Wait for AUTH; the replay re-queues it. The sub counts as done for now.
      wire.state = "parked";
      this.finishWire(wire, message);
    } else if (push.type === "rate-limit" && retryable) {
      wire.state = "queued"; // the relay already closed it — no CLOSE needed
      wire.retries++;
      this.queue.unshift(wire.id);
      this.cooldown(push.retryMs);
      if (!/bandwidth|bytes/i.test(message)) this.slowDown();
    } else if (push.type === "too-many-subs" && retryable) {
      wire.state = "queued";
      wire.retries++;
      this.queue.unshift(wire.id);
      this.applySubLimit(push);
      this.cooldown();
    } else if (push.type === "too-large" && retryable && this.splitInPlace(wire)) {
      // Replaced by two smaller queued REQs.
    } else {
      // Terminal refusal: the sub is done on this relay and is not re-sent on
      // reconnect.
      this.finishWire(wire, message);
      this.unqueue(wire);
      this.wires.delete(wire.id);
    }
    this.pump();
  }

  /**
   * A NOTICE carries no sub id, so pushback in one is pinned on the REQ we sent
   * last — the usual trigger for "too many subscriptions" / "message too large".
   */
  private onNotice(message: string): void {
    const push = classifyPushback(message);
    const last = this.lastSentWire ? this.wires.get(this.lastSentWire) : undefined;
    const retryable = !!last && last.state === "open" && last.retries < MAX_PUSHBACK_RETRIES;
    if (push.type === "rate-limit") {
      this.cooldown(push.retryMs);
      // Message-rate limits slow our pacing; a bandwidth budget (bytes we
      // download) isn't helped by sending fewer REQs per second.
      if (!/bandwidth|bytes/i.test(message)) this.slowDown();
    } else if (push.type === "too-many-subs") {
      this.applySubLimit(push);
      if (retryable) this.requeue(last!);
      this.cooldown();
    } else if (push.type === "too-large" && retryable) {
      if (!this.splitWire(last!)) {
        this.finishWire(last!, message);
        this.dropWire(last!);
      }
    }
    this.pump();
  }

  private nextBackoff(): number {
    const exp = Math.min(
      this.opts.maxBackoffMs,
      this.opts.baseBackoffMs * 2 ** this.backoffAttempts
    );
    this.backoffAttempts++;
    // Full jitter so a fleet of relays doesn't reconnect in lockstep.
    return Math.random() * exp;
  }
}
