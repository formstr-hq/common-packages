import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event,
  type EventTemplate,
  type Filter,
} from "nostr-tools";

import type { KanbanCtx, KanbanSigner, NostrRuntime, SubscriptionHandle } from "../src/contracts";

/** In-memory relay. Applies NIP-01 addressable replacement so tests see real behaviour. */
export class FakeRuntime implements NostrRuntime {
  readonly published: Event[] = [];
  private readonly store = new Map<string, Event>();

  private keyOf(event: Event): string {
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
      return `${event.kind}:${event.pubkey}:${dTag}`;
    }
    return event.id;
  }

  seed(event: Event): void {
    this.store.set(this.keyOf(event), event);
  }

  async publish(_relays: string[], event: Event): Promise<void> {
    this.published.push(event);
    const key = this.keyOf(event);
    const existing = this.store.get(key);
    if (
      !existing ||
      event.created_at > existing.created_at ||
      (event.created_at === existing.created_at && event.id < existing.id)
    ) {
      this.store.set(key, event);
    }
  }

  async querySync(_relays: string[], filter: Filter): Promise<Event[]> {
    return [...this.store.values()].filter((event) => {
      if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
      if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
      if (filter.ids && !filter.ids.includes(event.id)) return false;
      for (const [key, values] of Object.entries(filter)) {
        if (!key.startsWith("#")) continue;
        const letter = key.slice(1);
        const tagValues = event.tags.filter((t) => t[0] === letter).map((t) => t[1]);
        if (!(values as string[]).some((v) => tagValues.includes(v))) return false;
      }
      return true;
    });
  }

  subscribe(): SubscriptionHandle {
    return { unsub: () => {} };
  }
}

export function fakeSigner(secretKey = generateSecretKey()): KanbanSigner {
  const pubkey = getPublicKey(secretKey);
  return {
    getPublicKey: async () => pubkey,
    signEvent: async (template: EventTemplate) => finalizeEvent(template, secretKey) as Event,
    nip44Encrypt: async (peer: string, plaintext: string) =>
      nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secretKey, peer)),
    nip44Decrypt: async (peer: string, ciphertext: string) =>
      nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secretKey, peer)),
  };
}

export function makeCtx(
  overrides: { signer?: KanbanSigner; runtime?: NostrRuntime } = {},
): KanbanCtx & { runtime: FakeRuntime } {
  const runtime = (overrides.runtime as FakeRuntime) ?? new FakeRuntime();
  const signer = overrides.signer ?? fakeSigner();
  return {
    getSigner: async () => signer,
    runtime,
    relays: ["wss://test.relay/"],
  } as KanbanCtx & { runtime: FakeRuntime };
}
