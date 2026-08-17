import { generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";

import type { NostrRuntime, SubscriptionHandle } from "../src/contracts";
import { LocalSigner } from "../src/crypto/localSigner";
import { ADDRESSABLE_KINDS } from "../src/kinds";
import { supersedes } from "../src/discovery/dedupe";

/** A signer plus its pubkey, which every test needs together. */
export interface TestUser {
  secretKey: Uint8Array;
  pubkey: string;
  signer: LocalSigner;
}

export function makeUser(): TestUser {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey), signer: new LocalSigner(secretKey) };
}

function dTagOf(event: Event): string {
  return event.tags.find((t) => t[0] === "d")?.[1] ?? "";
}

function addressableKey(event: Event): string | null {
  return ADDRESSABLE_KINDS.includes(event.kind)
    ? `${event.kind}:${event.pubkey}:${dTagOf(event)}`
    : null;
}

function matchesFilter(event: Event, filter: Filter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const name = key.slice(1);
    const wanted = values as string[];
    const has = event.tags.some((t) => t[0] === name && wanted.includes(t[1]));
    if (!has) return false;
  }
  return true;
}

/**
 * In-memory relay implementing the parts of NIP-01 the SDK depends on:
 * addressable replacement with the lowest-id tie-break, tag filters, and live
 * subscriptions.
 *
 * `publish` applies replacement; `seed` does not, so a test can plant two
 * versions of one coordinate deliberately.
 */
export class FakeRuntime implements NostrRuntime {
  readonly published: Event[] = [];
  private readonly byId = new Map<string, Event>();
  private readonly subscribers = new Set<{
    filters: Filter[];
    onEvent?: (event: Event) => void;
  }>();
  disposed = false;

  seed(...events: Event[]): void {
    for (const event of events) this.byId.set(event.id, event);
  }

  all(): Event[] {
    return [...this.byId.values()];
  }

  /** Events published so far of a given kind, oldest first. */
  publishedOfKind(kind: number): Event[] {
    return this.published.filter((e) => e.kind === kind);
  }

  async querySync(_relays: string[], filter: Filter): Promise<Event[]> {
    const matched = this.all().filter((event) => matchesFilter(event, filter));
    matched.sort((a, b) => b.created_at - a.created_at);
    return filter.limit !== undefined ? matched.slice(0, filter.limit) : matched;
  }

  subscribe(
    _relays: string[],
    filters: Filter[],
    options: { onEvent?: (event: Event) => void; onEose?: () => void } = {},
  ): SubscriptionHandle {
    for (const event of this.all()) {
      if (filters.some((filter) => matchesFilter(event, filter))) options.onEvent?.(event);
    }
    options.onEose?.();

    const entry = { filters, onEvent: options.onEvent };
    this.subscribers.add(entry);
    return { unsub: () => this.subscribers.delete(entry) };
  }

  async publish(_relays: string[], event: Event): Promise<void> {
    this.published.push(event);

    const key = addressableKey(event);
    if (key) {
      const incumbent = this.all().find((e) => addressableKey(e) === key);
      if (incumbent) {
        if (!supersedes(event, incumbent)) return;
        this.byId.delete(incumbent.id);
      }
    }
    this.byId.set(event.id, event);

    for (const subscriber of this.subscribers) {
      if (subscriber.filters.some((filter) => matchesFilter(event, filter))) {
        subscriber.onEvent?.(event);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.subscribers.clear();
  }
}
