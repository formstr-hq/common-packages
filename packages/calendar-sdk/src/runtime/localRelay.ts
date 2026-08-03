import type { Event, Filter } from "nostr-tools";

import type { NostrRuntime, SubscriptionHandle } from "../contracts";

/**
 * Adapter for `@formstr/local-relay`, the worker-backed data layer
 * calendar.formstr.app runs on.
 *
 * Why bother, when `SimplePoolRuntime` already works: the local relay owns
 * every connection decision from the union of active interests, caches events
 * across sessions, and keeps a durable outbox that retries. Running the SDK on
 * the host's existing data layer means one connection policy for the whole app
 * instead of the SDK opening a second set of sockets alongside it.
 *
 * Imported through the `@formstr/calendar-sdk/local-relay` entry so the main
 * entry never pulls in the optional peer dependency.
 */

/** The slice of `DataLayer` this adapter uses — structural, so no import. */
export interface LocalRelayDataLayer {
  observe(
    filters: Filter[],
    handlers: { onEvent: (event: Event) => void; onEose?: () => void },
    options?: { localOnly?: boolean; relays?: string[] },
  ): { unobserve: () => void };
  publishEvent(event: Event): Promise<{ ok: boolean; accepted: number; total: number }>;
  addGossipRelay?(url: string): void;
}

export interface LocalRelayRuntimeOptions {
  /**
   * How long a `querySync` waits before resolving with what it has.
   *
   * EOSE is NOT completion here: the data layer fires it after the local store
   * replay, which on a cold cache is empty — the upstream fetch streams in
   * afterwards. So a one-shot read settles on a quiet period instead.
   */
  timeoutMs?: number;
  /** Settle once this long passes with no new event. */
  quietMs?: number;
}

export class LocalRelayRuntime implements NostrRuntime {
  private readonly timeoutMs: number;
  private readonly quietMs: number;

  constructor(
    private readonly dataLayer: LocalRelayDataLayer,
    options: LocalRelayRuntimeOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.quietMs = options.quietMs ?? 700;
  }

  /**
   * `relays` are read HINTS, not connection targets — the worker folds them
   * into its routing for this interest and still decides what to open.
   */
  querySync(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]> {
    return new Promise((resolve) => {
      const collected = new Map<string, Event>();
      let settled = false;
      let quietTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (quietTimer) clearTimeout(quietTimer);
        handle.unobserve();
        resolve([...collected.values()]);
      };

      // Hard cap so a read can never hang, and so a cold miss is bounded.
      const hardTimer = setTimeout(finish, timeoutMs ?? this.timeoutMs);

      const handle = this.dataLayer.observe(
        [filter],
        {
          // Deliberately no onEose: local EOSE is not completion, see above.
          onEvent: (event) => {
            collected.set(event.id, event);
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, this.quietMs);
          },
        },
        relays.length > 0 ? { relays } : undefined,
      );
    });
  }

  subscribe(
    relays: string[],
    filters: Filter[],
    options: { onEvent?: (event: Event) => void; onEose?: () => void } = {},
  ): SubscriptionHandle {
    const handle = this.dataLayer.observe(
      filters,
      { onEvent: (event) => options.onEvent?.(event), onEose: options.onEose },
      relays.length > 0 ? { relays } : undefined,
    );
    return { unsub: () => handle.unobserve() };
  }

  /**
   * The worker owns routing (user relays ∪ author outbox ∪ p-tagged recipients'
   * inbox) and keeps retrying through its durable outbox, so zero acceptances
   * means "queued", not "failed" — this never throws. `relays` are fed to the
   * gossip pool as hints when the data layer accepts them.
   */
  async publish(relays: string[], event: Event): Promise<void> {
    if (this.dataLayer.addGossipRelay) {
      for (const relay of relays) this.dataLayer.addGossipRelay(relay);
    }
    await this.dataLayer.publishEvent(event);
  }

  /**
   * Deliberately absent behaviour: the data layer's lifetime belongs to the
   * host, so disposing the SDK must not tear down the host's worker.
   */
  dispose(): void {}
}
