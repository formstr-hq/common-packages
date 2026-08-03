import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools";
import type { Event, Filter } from "nostr-tools";

import { LocalRelayRuntime, type LocalRelayDataLayer } from "./localRelay";

const sk = generateSecretKey();

function event(content: string): Event {
  return finalizeEvent(
    { kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content },
    sk,
  );
}

/** Minimal stand-in for `@formstr/local-relay`'s DataLayer. */
function fakeDataLayer(
  script: (emit: (event: Event) => void, eose: () => void) => void = () => {},
) {
  const observed: { filters: Filter[]; options?: { relays?: string[] } }[] = [];
  const gossip: string[] = [];
  const published: Event[] = [];
  let unobserved = 0;

  const dataLayer: LocalRelayDataLayer = {
    observe(filters, handlers, options) {
      observed.push({ filters, options });
      script(handlers.onEvent, () => handlers.onEose?.());
      return { unobserve: () => { unobserved += 1; } };
    },
    async publishEvent(e) {
      published.push(e);
      return { ok: true, accepted: 1, total: 1 };
    },
    addGossipRelay(url) {
      gossip.push(url);
    },
  };

  return { dataLayer, observed, gossip, published, unobservedCount: () => unobserved };
}

describe("LocalRelayRuntime.querySync", () => {
  it("settles on a quiet period rather than on EOSE", async () => {
    // EOSE fires after the LOCAL store replay, which is empty on a cold cache.
    // Treating it as completion returns nothing on exactly the reads that need
    // the network most.
    const fake = fakeDataLayer((emit, eose) => {
      eose();
      setTimeout(() => emit(event("late")), 5);
    });
    const runtime = new LocalRelayRuntime(fake.dataLayer, { quietMs: 20, timeoutMs: 500 });

    const events = await runtime.querySync([], { kinds: [1] });
    expect(events.map((e) => e.content)).toEqual(["late"]);
  });

  it("dedupes by id", async () => {
    const duplicate = event("same");
    const fake = fakeDataLayer((emit) => {
      emit(duplicate);
      emit(duplicate);
    });
    const runtime = new LocalRelayRuntime(fake.dataLayer, { quietMs: 5 });
    expect(await runtime.querySync([], { kinds: [1] })).toHaveLength(1);
  });

  it("gives up at the hard timeout when nothing ever arrives", async () => {
    const runtime = new LocalRelayRuntime(fakeDataLayer().dataLayer, { timeoutMs: 15 });
    expect(await runtime.querySync([], { kinds: [1] })).toEqual([]);
  });

  it("drops the interest once it settles", async () => {
    const fake = fakeDataLayer((emit) => emit(event("x")));
    const runtime = new LocalRelayRuntime(fake.dataLayer, { quietMs: 5 });
    await runtime.querySync([], { kinds: [1] });
    expect(fake.unobservedCount()).toBe(1);
  });

  it("passes relays as read hints, and omits the option when there are none", async () => {
    const fake = fakeDataLayer();
    const runtime = new LocalRelayRuntime(fake.dataLayer, { timeoutMs: 10 });
    await runtime.querySync(["wss://hint"], { kinds: [1] });
    await runtime.querySync([], { kinds: [1] });
    expect(fake.observed[0].options).toEqual({ relays: ["wss://hint"] });
    expect(fake.observed[1].options).toBeUndefined();
  });
});

describe("LocalRelayRuntime.subscribe", () => {
  it("forwards events and EOSE, and unobserves on unsub", () => {
    const onEvent = vi.fn();
    const onEose = vi.fn();
    const fake = fakeDataLayer((emit, eose) => {
      emit(event("x"));
      eose();
    });
    const runtime = new LocalRelayRuntime(fake.dataLayer);

    const handle = runtime.subscribe([], [{ kinds: [1] }], { onEvent, onEose });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEose).toHaveBeenCalledTimes(1);

    handle.unsub();
    expect(fake.unobservedCount()).toBe(1);
  });
});

describe("LocalRelayRuntime.publish", () => {
  it("feeds relay hints to the gossip pool and never throws on zero acceptance", async () => {
    const fake = fakeDataLayer();
    const runtime = new LocalRelayRuntime(fake.dataLayer);
    await runtime.publish(["wss://hint"], event("x"));
    expect(fake.gossip).toEqual(["wss://hint"]);
    expect(fake.published).toHaveLength(1);
  });

  it("leaves the host's data layer running on dispose", () => {
    // The data layer's lifetime belongs to the host — disposing the SDK must
    // not tear down the app's worker.
    const fake = fakeDataLayer();
    const runtime = new LocalRelayRuntime(fake.dataLayer);
    runtime.dispose();
    expect(fake.unobservedCount()).toBe(0);
  });
});
