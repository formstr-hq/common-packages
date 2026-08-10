import { SimplePool, type Event, type Filter } from "nostr-tools";

import type { NostrRuntime, SubscriptionHandle } from "../contracts";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Zero-config `NostrRuntime` over nostr-tools' SimplePool.
 *
 * Note on `subscribe`: the runtime contract takes `Filter[]` (shared with
 * `@formstr/calendar-sdk`), but `SimplePool.subscribeMany` accepts exactly one
 * filter as of nostr-tools 2.23. We fan out to one subscription per filter and
 * join them behind a single handle, reporting EOSE once the last one drains.
 */
export class SimplePoolRuntime implements NostrRuntime {
  private readonly pool = new SimplePool();

  async querySync(
    relays: string[],
    filter: Filter,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Event[]> {
    return this.pool.querySync(relays, filter, { maxWait: timeoutMs });
  }

  subscribe(
    relays: string[],
    filters: Filter[],
    options: { onEvent?: (event: Event) => void; onEose?: () => void } = {},
  ): SubscriptionHandle {
    let pending = filters.length;
    const subs = filters.map((filter) =>
      this.pool.subscribeMany(relays, filter, {
        onevent: (event) => options.onEvent?.(event),
        oneose: () => {
          pending -= 1;
          if (pending === 0) options.onEose?.();
        },
      }),
    );

    if (filters.length === 0) options.onEose?.();

    return {
      unsub: () => {
        for (const sub of subs) sub.close();
      },
    };
  }

  async publish(relays: string[], event: Event, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
    const publishes = this.pool.publish(relays, event, { maxWait: timeoutMs });
    await Promise.race([
      Promise.allSettled(publishes),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  dispose(): void {
    this.pool.destroy();
  }
}
