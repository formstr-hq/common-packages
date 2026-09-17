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
 * it, replies `["AUTH", event]`, and re-issues every active REQ — the ones sent
 * before the challenge were not honoured. Without `onAuth` the challenge is
 * ignored, which is the correct behavior for a relay that never challenges.
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
}

import type { Socket, SocketFactory } from "./Socket";

export class RelayConnection {
  private socket: Socket | null = null;
  private sendQueue: unknown[] = [];
  private activeReqs = new Map<string, Filter[]>();
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
      this.backoffAttempts = 0;
      // A fresh socket must authenticate afresh; the relay will re-challenge.
      this.authChallenge = null;
      this.authInFlight = false;
      // Resubscribe everything that was active before the (re)connect.
      for (const [subId, filters] of Array.from(this.activeReqs.entries())) {
        this.write(["REQ", subId, ...filters]);
      }
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

  req(subId: string, filters: Filter[]): void {
    // REQs live in activeReqs and are (re)sent on open/reconnect from there —
    // never via the send queue, or they'd be transmitted twice.
    this.activeReqs.set(subId, filters);
    if (this.connected) this.write(["REQ", subId, ...filters]);
    else this.connect();
  }

  close(subId: string): void {
    const existed = this.activeReqs.delete(subId);
    // Only emit CLOSE if the REQ was actually on the wire; if we never opened,
    // dropping it from activeReqs is enough (open won't resubscribe it).
    if (existed && this.connected) this.write(["CLOSE", subId]);
  }

  publish(event: Event): void {
    this.enqueue(["EVENT", event]);
  }

  /** Permanently close this connection (no reconnect). */
  destroy(): void {
    this.closedByUs = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.activeReqs.clear();
    try {
      this.socket?.close();
    } catch {
      /* already gone */
    }
    this.socket = null;
  }

  /** Queue non-REQ messages (publishes) until the socket is open. REQs do NOT
   * use this path — they're resent from activeReqs on open. */
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
        this.handlers.onEvent(msg[1], msg[2], this.url);
        break;
      case "EOSE":
        this.handlers.onEose(msg[1], this.url);
        break;
      case "CLOSED":
        this.handlers.onClosed(msg[1], this.url, msg[2] ?? "");
        break;
      case "OK":
        this.handlers.onOk?.(msg[1], !!msg[2], msg[3] ?? "", this.url);
        break;
      case "AUTH":
        void this.authenticate(String(msg[1] ?? ""));
        break;
      // NOTICE is informational.
    }
  }

  /**
   * Answer a NIP-42 challenge: sign kind 22242 and re-issue every active REQ.
   *
   * REQs sent before the challenge are not honoured by the relay, so the
   * resubscribe after AUTH is what actually starts the data flowing. A refusal
   * or missing hook is not an error — the relay simply stays unauthenticated,
   * and its CLOSED/deadline handling above treats it as done.
   */
  private async authenticate(challenge: string): Promise<void> {
    if (!this.handlers.onAuth || !challenge) return;
    // Never sign two challenges concurrently, and never re-sign one we have
    // already answered on this socket (a relay may re-send AUTH at any time).
    if (this.authInFlight || this.authChallenge === challenge) return;
    this.authChallenge = challenge;
    this.authInFlight = true;
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
      // Refused, or the socket died while we were signing — either way, do not
      // authenticate a stale socket.
      if (!event || !this.connected) return;
      this.write(["AUTH", event]);
      // The relay ignored every REQ sent before AUTH; replay them now.
      for (const [subId, filters] of Array.from(this.activeReqs.entries())) {
        this.write(["REQ", subId, ...filters]);
      }
    } catch {
      // A throwing signer must not break the connection; stay unauthenticated.
    } finally {
      this.authInFlight = false;
    }
  }

  private onDrop(): void {
    this.socket = null;
    if (this.closedByUs || !this.opts.autoReconnect) return;
    const delay = this.nextBackoff();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
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
