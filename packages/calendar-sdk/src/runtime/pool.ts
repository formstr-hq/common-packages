import { SimplePool } from "nostr-tools/pool";
import type { Event, Filter } from "nostr-tools";

import type { NostrRuntime, SubscriptionHandle } from "../contracts";
import { normalizeRelayList } from "../discovery/relays";

/**
 * The default `NostrRuntime`: a `SimplePool` over plain websockets.
 *
 * Hosts that already own a pool or a cache inject their own runtime instead —
 * see `runtime/localRelay.ts` for the `@formstr/local-relay` adapter, which is
 * what calendar.formstr.app runs on.
 */
export class SimplePoolRuntime implements NostrRuntime {
  private readonly pool: SimplePool;
  /**
   * Every relay this runtime has touched.
   *
   * `SimplePool.close([])` closes nothing, so a `dispose()` that forwards an
   * empty list leaks every socket. Tracking what was opened is the only way to
   * close it.
   */
  private readonly opened = new Set<string>();
  private readonly defaultTimeoutMs: number;

  constructor(options: { timeoutMs?: number; pool?: SimplePool } = {}) {
    this.pool = options.pool ?? new SimplePool();
    this.defaultTimeoutMs = options.timeoutMs ?? 4000;
  }

  private track(relays: string[]): string[] {
    const normalized = normalizeRelayList(relays);
    for (const relay of normalized) this.opened.add(relay);
    return normalized;
  }

  /**
   * Collects until EOSE or the timeout, whichever is first.
   *
   * EOSE alone is not enough to stop: relays differ on when they send it, and
   * one silent relay in the set would otherwise hang the call forever.
   */
  async querySync(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]> {
    const urls = this.track(relays);
    if (urls.length === 0) return [];

    return new Promise<Event[]>((resolve) => {
      const collected = new Map<string, Event>();
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sub.close();
        resolve([...collected.values()]);
      };

      const timer = setTimeout(finish, timeoutMs ?? this.defaultTimeoutMs);
      const sub = this.pool.subscribeMany(urls, filter, {
        onevent: (event: Event) => collected.set(event.id, event),
        oneose: finish,
      });
    });
  }

  /**
   * `SimplePool` takes one filter per subscription, so a multi-filter interest
   * (the invitation inbox needs two — current and legacy wraps) becomes one
   * subscription each. EOSE is reported once every one of them has fired,
   * otherwise a caller waiting for the backlog would act on half of it.
   */
  subscribe(
    relays: string[],
    filters: Filter[],
    options: { onEvent?: (event: Event) => void; onEose?: () => void } = {},
  ): SubscriptionHandle {
    const urls = this.track(relays);
    if (urls.length === 0 || filters.length === 0) return { unsub: () => {} };

    let pendingEose = filters.length;
    const subs = filters.map((filter) =>
      this.pool.subscribeMany(urls, filter, {
        onevent: (event: Event) => options.onEvent?.(event),
        oneose: () => {
          pendingEose -= 1;
          if (pendingEose === 0) options.onEose?.();
        },
      }),
    );
    return {
      unsub: () => {
        for (const sub of subs) sub.close();
      },
    };
  }

  /**
   * Best-effort fan-out: a relay that rejects or times out must not fail the
   * call. Zero acceptances is not distinguishable from success here — callers
   * that need per-relay outcomes should inject a runtime that reports them.
   */
  async publish(relays: string[], event: Event, timeoutMs?: number): Promise<void> {
    const urls = this.track(relays);
    if (urls.length === 0) return;

    const deadline = new Promise<void>((resolve) =>
      setTimeout(resolve, timeoutMs ?? this.defaultTimeoutMs),
    );
    await Promise.race([
      Promise.allSettled(this.pool.publish(urls, event)).then(() => undefined),
      deadline,
    ]);
  }

  dispose(): void {
    this.pool.close([...this.opened]);
    this.opened.clear();
  }
}
