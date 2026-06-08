import { matchFilter, type Event as NostrEvent, type Filter } from 'nostr-tools';
import type {
  AbstractSimplePool,
  SubCloser,
  SubscribeManyParams,
} from 'nostr-tools/abstract-pool';

interface Subscription {
  filter: Filter;
  params: SubscribeManyParams;
  closed: boolean;
}

class MockRelay {
  readonly events: NostrEvent[] = [];
  private readonly subs: Subscription[] = [];

  publish(event: NostrEvent): void {
    this.events.push(event);
    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (!matchFilter(sub.filter, event)) continue;
      queueMicrotask(() => {
        if (!sub.closed) sub.params.onevent?.(event);
      });
    }
  }

  subscribe(filter: Filter, params: SubscribeManyParams): Subscription {
    const sub: Subscription = { filter, params, closed: false };
    this.subs.push(sub);
    queueMicrotask(() => {
      if (!sub.closed) sub.params.oneose?.();
    });
    return sub;
  }
}

/**
 * In-memory pool that satisfies the subset of AbstractSimplePool that
 * nostr-tools' BunkerSigner actually calls (subscribe + publish).
 */
export class MockPool {
  readonly relays = new Map<string, MockRelay>();

  getRelay(url: string): MockRelay {
    let relay = this.relays.get(url);
    if (!relay) {
      relay = new MockRelay();
      this.relays.set(url, relay);
    }
    return relay;
  }

  subscribe(urls: string[], filter: Filter, params: SubscribeManyParams): SubCloser {
    const subs = urls.map((url) => this.getRelay(url).subscribe(filter, params));
    let onCloseFired = false;
    const fireClose = (reasons: string[]): void => {
      if (onCloseFired) return;
      onCloseFired = true;
      for (const s of subs) s.closed = true;
      // Defer to a microtask so callers that close from inside `onevent`
      // can finish their handler (e.g. set a `success` flag) before
      // `onclose` runs. Mirrors how a real relay's CLOSE is async.
      queueMicrotask(() => params.onclose?.(reasons));
    };
    if (params.maxWait) {
      setTimeout(() => fireClose(['max wait reached']), params.maxWait);
    }
    if (params.abort) {
      const onAbort = (): void => fireClose(['aborted']);
      if (params.abort.aborted) onAbort();
      else params.abort.addEventListener('abort', onAbort, { once: true });
    }
    return {
      close: (reason?: string) => fireClose(reason ? [reason] : []),
    };
  }

  publish(urls: string[], event: NostrEvent): Promise<string>[] {
    return urls.map((url) => {
      this.getRelay(url).publish(event);
      return Promise.resolve(url);
    });
  }

  // No-ops to satisfy unused-but-callable methods on AbstractSimplePool.
  ensureRelay(): Promise<unknown> {
    return Promise.resolve(null);
  }
  close(): void {}
  destroy(): void {}
  listConnectionStatus(): Map<string, boolean> {
    return new Map([...this.relays.keys()].map((u) => [u, true]));
  }

  /** Cast to AbstractSimplePool for use with nostr-tools' BunkerSigner. */
  asPool(): AbstractSimplePool {
    return this as unknown as AbstractSimplePool;
  }
}
