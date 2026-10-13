import { matchFilter, type Event, type Filter } from "nostr-tools";
import { normalizeURL } from "nostr-tools/utils";
import type { RelayPoolLike } from "../src/index.js";

export const n = (url: string) => normalizeURL(url);

/** A small in-memory network of relays behind a SimplePool-shaped interface. */
export class FakeNetwork {
  readonly relays = new Map<string, Map<string, Event>>();
  /** Relays that accept connections and then never answer: no events, no EOSE, no publish OK. */
  silent = new Set<string>();
  /** Relays that refuse every publish, with this reason. */
  refusing = new Map<string, string>();
  readonly subscribeCalls: Array<{ relays: string[]; filter: Filter }> = [];
  readonly closed: string[][] = [];
  private readonly live = new Set<{ relay: string; filter: Filter; onevent(e: Event): void }>();

  relay(url: string): Map<string, Event> {
    let store = this.relays.get(url);
    if (!store) this.relays.set(url, (store = new Map()));
    return store;
  }

  seed(url: string, ...events: Event[]): this {
    for (const e of events) this.relay(n(url)).set(e.id, e);
    return this;
  }

  pool(): RelayPoolLike & { seenOn: Map<string, Set<{ url: string }>> } {
    const net = this;
    const seenOn = new Map<string, Set<{ url: string }>>();
    const pool: RelayPoolLike & { seenOn: Map<string, Set<{ url: string }>> } = {
      seenOn,
      trackRelays: false,
      subscribeMany(relays, filter, params) {
        net.subscribeCalls.push({ relays, filter });
        let closed = false;
        let pending = 0;
        let fired = false;
        const fire = () => { if (!fired && !closed) { fired = true; params.oneose?.(); } };
        const timer = params.maxWait ? setTimeout(fire, params.maxWait) : undefined;
        for (const relay of relays) {
          // A real pool waits for EVERY relay before reporting EOSE (or gives up at maxWait), so a silent
          // relay counts as pending forever.
          pending += 1;
          if (net.silent.has(relay)) continue;
          const entry = {
            relay,
            filter,
            onevent: (event: Event) => {
              if (closed) return;
              if (pool.trackRelays) (seenOn.get(event.id) ?? seenOn.set(event.id, new Set()).get(event.id)!).add({ url: relay });
              params.onevent(event);
            },
          };
          net.live.add(entry);
          queueMicrotask(() => {
            for (const event of net.relay(relay).values()) if (matchFilter(filter, event)) entry.onevent(event);
            pending -= 1;
            if (pending === 0) fire();
          });
        }
        if (pending === 0 && relays.every((r) => !net.silent.has(r))) queueMicrotask(() => params.onclose?.([]));
        return { close: () => { closed = true; clearTimeout(timer); } };
      },
      publish(relays, event) {
        return relays.map((relay) => {
          if (net.silent.has(relay)) return new Promise<string>(() => {});
          const reason = net.refusing.get(relay);
          if (reason) return Promise.reject(new Error(reason));
          net.relay(relay).set(event.id, event);
          for (const sub of net.live) if (sub.relay === relay && matchFilter(sub.filter, event)) sub.onevent(event);
          return Promise.resolve("");
        });
      },
      close(relays) { net.closed.push(relays); },
    };
    return pool;
  }
}
