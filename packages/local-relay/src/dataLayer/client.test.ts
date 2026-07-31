import { DataLayer, setDataLayer, getDataLayer, dataLayer as ambient } from "./client";
import { RelayService } from "../localRelay/RelayService";
import { LocalRelayClient } from "../localRelay/transport/LocalRelayClient";
import { createChannelPair } from "../localRelay/transport/channel";
import { MemoryStorage } from "../localRelay/storage/MemoryStorage";
import { fakeSocketFactory, makeEvent } from "../localRelay/testkit";
import type { EventTemplate } from "nostr-tools";

const NOW = 1_000_000;
const settle = () => new Promise((r) => setTimeout(r, 80));

async function wire() {
  const { client: clientCh, worker: workerCh } = createChannelPair();
  const f = fakeSocketFactory();
  const service = new RelayService({
    channel: workerCh,
    socketFactory: f.factory,
    storage: new MemoryStorage(),
    verify: () => true,
    now: () => NOW,
  });
  await service.start();
  const client = new LocalRelayClient(clientCh);
  client.setUserRelays(["wss://u1"]);
  // Sign = stamp the template into a complete event (no real crypto in tests).
  const sign = async (t: EventTemplate) =>
    makeEvent({ id: "s".repeat(64), kind: t.kind, pubkey: "me", content: t.content, tags: t.tags });
  const dataLayer = new DataLayer({ client, sign });
  await settle();
  return { f, service, client, dataLayer };
}

describe("DataLayer", () => {
  it("publish signs, stores locally, sends upstream, and reports per-relay outcome", async () => {
    const { f, service, dataLayer } = await wire();

    const pending = dataLayer.publish({ kind: 1, content: "hi", tags: [], created_at: NOW });
    await settle();

    expect(service.db.getById("s".repeat(64))).toBeDefined(); // stored locally
    const sock = f.last("wss://u1");
    sock.open(); // flush the queued publish
    expect(sock.sent.some((m) => m[0] === "EVENT" && m[1].id === "s".repeat(64))).toBe(true);

    sock.emit(["OK", "s".repeat(64), true, ""]); // relay accepts
    const { event, result } = await pending;

    expect(event.id).toBe("s".repeat(64));
    expect(result.ok).toBe(true);
    expect(result.relayResults).toEqual([
      { relay: "wss://u1", status: "accepted", message: undefined, latencyMs: expect.any(Number) },
    ]);
  });

  it("publishEvent reports a rejection reason from the relay", async () => {
    const { f, dataLayer } = await wire();
    const ev = makeEvent({ id: "r".repeat(64), kind: 1, pubkey: "me" });

    const pending = dataLayer.publishEvent(ev);
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    sock.emit(["OK", "r".repeat(64), false, "blocked: spam"]);

    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.relayResults[0]).toMatchObject({ status: "rejected", message: "blocked: spam" });
  });

  it("relayHealth reports configured + connected relays", async () => {
    const { f, dataLayer } = await wire();
    // An interest gives the worker a reason to connect to wss://u1.
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    f.last("wss://u1").open();

    const health = await dataLayer.relayHealth();
    expect(health.find((h) => h.relay === "wss://u1")?.connected).toBe(true);
  });

  it("fetchById returns a cached event without touching the network", async () => {
    const { f, service, dataLayer } = await wire();
    service.db.add(makeEvent({ id: "c".repeat(64), kind: 1, pubkey: "alice" }));

    const found = await dataLayer.fetchById("c".repeat(64));

    expect(found?.id).toBe("c".repeat(64));
    expect(f.count("wss://u1")).toBe(0); // cache hit opened no socket
  });

  it("fetchById resolves null on a cache miss WITHOUT opening a socket", async () => {
    const { f, dataLayer } = await wire();
    // A read is cache-only: a miss never triggers a fetch (the worker, not the
    // app, drives the network), so it resolves null and opens nothing.
    expect(await dataLayer.fetchById("z".repeat(64))).toBeNull();
    expect(f.count("wss://u1")).toBe(0);
  });

  it("fetchReplaceable returns the current cached value without network", async () => {
    const { f, service, dataLayer } = await wire();
    service.db.add(makeEvent({ id: "p".repeat(64), kind: 0, pubkey: "alice", content: "{}" }));

    const found = await dataLayer.fetchReplaceable(0, "alice");

    expect(found?.id).toBe("p".repeat(64));
    expect(f.count("wss://u1")).toBe(0);
  });

  it("addEvent / addEvents put events in the local store with no network", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.addEvent(makeEvent({ id: "x".repeat(64), kind: 1, pubkey: "alice" }));
    dataLayer.addEvents([
      makeEvent({ id: "y".repeat(64), kind: 1, pubkey: "alice" }),
      makeEvent({ id: "z".repeat(64), kind: 1, pubkey: "alice" }),
    ]);
    await settle();

    expect((await dataLayer.fetchById("x".repeat(64)))?.id).toBe("x".repeat(64));
    expect((await dataLayer.fetchById("y".repeat(64)))?.id).toBe("y".repeat(64));
    expect(f.count("wss://u1")).toBe(0);
  });

  it("setUserRelays retargets where an author-less sync interest connects", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.setUserRelays(["wss://u2"]);
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }); // author-less → user relays
    await settle();
    expect(f.count("wss://u2")).toBe(1);
  });

  it("setDmRelays routes the kind-1059 DM stream to the DM inbox relays", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.setDmRelays(["wss://dm1"]);
    dataLayer.observe([{ kinds: [1059] }], { onEvent: () => {} }); // DM read
    await settle();
    expect(f.count("wss://dm1")).toBe(1);
  });

  it("seenOn reports the relays a cached event arrived on", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const sub = sock.sent.filter((m: any) => m[0] === "REQ")[0][1];
    const id = "a".repeat(64);
    sock.emit(["EVENT", sub, makeEvent({ id, kind: 1, pubkey: "alice" })]);
    await settle();
    expect(await dataLayer.seenOn(id)).toEqual(["wss://u1"]);
  });

  it("online() reflects user-relay connectivity through the data layer", async () => {
    const { f, dataLayer } = await wire();
    expect(await dataLayer.online()).toBe(false); // nothing connected
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} });
    await settle();
    f.last("wss://u1").open(); // onConnect → reachable
    await settle();
    expect(await dataLayer.online()).toBe(true);
  });

  it("retryDelivery passes through without error and diagnostics exposes the outbox", async () => {
    const { dataLayer } = await wire();
    expect(() => dataLayer.retryDelivery("a".repeat(64))).not.toThrow();
    expect(() => dataLayer.retryDelivery()).not.toThrow(); // all failed
    const diag = await dataLayer.diagnostics();
    expect(diag.delivery).toEqual({ records: [], pendingRelays: 0, failed: 0 });
    expect(typeof diag.online).toBe("boolean");
  });

  it("setActiveAccount is accepted as a scope-retarget hint", async () => {
    const { dataLayer } = await wire();
    expect(() => dataLayer.setActiveAccount("alice")).not.toThrow();
    expect(() => dataLayer.setActiveAccount(null)).not.toThrow();
  });

  it("pause closes sockets and resume reopens from standing interests", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    f.last("wss://u1").open();

    dataLayer.pause();
    await settle();
    expect(f.last("wss://u1").readyState).toBe(3);

    dataLayer.resume();
    await settle();
    expect(f.count("wss://u1")).toBe(2);
  });

  it("diagnostics exposes paused state, interests, upstream routing, cache, and health", async () => {
    const { service, dataLayer } = await wire();
    service.db.add(
      makeEvent({ id: "r".repeat(64), kind: 10002, pubkey: "alice", tags: [["r", "wss://alice-relay"]] })
    );
    dataLayer.setDmRelays(["wss://dm1"]);
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} }); // outbox-routed
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }); // author-less → user relays
    dataLayer.observe([{ kinds: [1059] }], { onEvent: () => {} }); // DM read → inbox relays
    await settle();

    const diag = await dataLayer.diagnostics();
    expect(diag.paused).toBe(false);
    expect(diag.interests).toHaveLength(3);
    expect(diag.interests.every((i) => i.sync)).toBe(true);
    expect(diag.dmRelays).toEqual(["wss://dm1"]);

    const routed = diag.upstream.flatMap((u) => u.relays);
    expect(routed).toContain("wss://alice-relay"); // author branch resolves via outbox
    expect(routed).toContain("wss://u1"); // author-less branch resolves via user relays
    expect(routed).toContain("wss://dm1"); // DM branch resolves via the inbox relays

    expect(diag.cache.totalEvents).toBeGreaterThanOrEqual(1); // the kind-10002 is stored
    expect(diag.relays.some((h) => h.relay === "wss://u1")).toBe(true);
    expect(diag.enrichment).toEqual({ queuedIds: 0, queuedAuthors: 0, pending: false });
  });

  it("diagnostics reports the paused lifecycle state", async () => {
    const { dataLayer } = await wire();
    dataLayer.pause();
    await settle();
    expect((await dataLayer.diagnostics()).paused).toBe(true);
  });
});

describe("DataLayer singleton accessor", () => {
  afterEach(() => setDataLayer(null));

  it("getDataLayer throws before bootstrap", () => {
    setDataLayer(null);
    expect(() => getDataLayer()).toThrow(/not bootstrapped/);
  });

  it("setDataLayer installs the instance getDataLayer returns", async () => {
    const { dataLayer } = await wire();
    setDataLayer(dataLayer);
    expect(getDataLayer()).toBe(dataLayer);
  });

  it("the ambient `dataLayer` proxy forwards methods and reads through to the instance", async () => {
    const { f, dataLayer } = await wire();
    setDataLayer(dataLayer);

    // method call goes through the bound proxy
    ambient.addEvent(makeEvent({ id: "x".repeat(64), kind: 1, pubkey: "alice" }));
    await settle();
    expect((await ambient.fetchById("x".repeat(64)))?.id).toBe("x".repeat(64));
    expect(f.count("wss://u1")).toBe(0);

    // a non-function / missing property reads through as-is (not bound)
    expect((ambient as unknown as Record<string, unknown>).notAMethod).toBeUndefined();
  });
});

describe("DataLayer gossip relays", () => {
  const reqSub = (sock: { sent: any[] }) => sock.sent.find((m) => m[0] === "REQ")![1] as string;

  it("an author-less interest fetches from a discovered relay (the DM-reference case)", async () => {
    const { f, service, dataLayer } = await wire();
    dataLayer.addGossipRelay("wss://gossip"); // hint extracted from a decrypted DM
    const got: string[] = [];
    dataLayer.observe([{ ids: ["d".repeat(64)] }], { onEvent: (e) => got.push(e.id) });
    await settle();

    expect(f.count("wss://gossip")).toBe(1); // worker dialed the discovered relay
    const sock = f.last("wss://gossip");
    sock.open();
    sock.emit(["EVENT", reqSub(sock), makeEvent({ id: "d".repeat(64), kind: 1, pubkey: "x" })]);
    await settle();
    expect(got).toEqual(["d".repeat(64)]);
    expect(service.db.getById("d".repeat(64))).toBeDefined();
  });

  it("enrichment reaches into the gossip pool for referenced events", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.addGossipRelay("wss://gossip");
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1"); // alice has no outbox → falls back to user relay
    sock.open();
    sock.emit([
      "EVENT",
      reqSub(sock),
      makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] }),
    ]);
    await new Promise((r) => setTimeout(r, 300)); // enrich debounce

    expect(f.count("wss://gossip")).toBe(1); // enrichment dialed the gossip relay too
    f.last("wss://gossip").open(); // flush the queued REQ
    const greq = f.last("wss://gossip").sent.find((m) => m[0] === "REQ");
    expect(greq.slice(2)).toEqual(expect.arrayContaining([expect.objectContaining({ ids: ["f".repeat(64)] })]));
  });

  it("diagnostics reports the pool, the per-relay gossip flag, and connection counts", async () => {
    const { f, service, dataLayer } = await wire();
    service.db.add(
      makeEvent({ id: "r".repeat(64), kind: 10002, pubkey: "alice", tags: [["r", "wss://alice-relay"]] })
    );
    dataLayer.addGossipRelay("wss://gossip");
    dataLayer.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} }); // → outbox alice-relay
    dataLayer.observe([{ ids: ["x".repeat(64)] }], { onEvent: () => {} }); // → user ∪ gossip
    await settle();
    f.last("wss://u1").open();
    f.last("wss://alice-relay").open();
    f.last("wss://gossip").open();
    await settle();

    const diag = await dataLayer.diagnostics();
    expect(diag.gossipRelays).toEqual(["wss://gossip"]);
    expect(diag.relays.find((h) => h.relay === "wss://gossip")).toMatchObject({ gossip: true, connected: true });
    expect(diag.relays.find((h) => h.relay === "wss://alice-relay")).toMatchObject({ gossip: false });
    expect(diag.connections.gossip).toBe(1); // wss://gossip
    expect(diag.connections.outbox).toBe(1); // wss://alice-relay (connected, not user, not gossip)
    expect(diag.connections.user).toBe(1); // wss://u1
    expect(diag.connections.total).toBe(3);
  });

  it("removeGossipRelay drops the relay so future fetches skip it", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.addGossipRelay("wss://gossip");
    dataLayer.removeGossipRelay("wss://gossip");
    dataLayer.removeGossipRelay("wss://not-in-pool"); // no-op
    dataLayer.observe([{ ids: ["x".repeat(64)] }], { onEvent: () => {} });
    await settle();

    expect(f.count("wss://gossip")).toBe(0); // removed → never targeted
    expect((await dataLayer.diagnostics()).gossipRelays).toEqual([]);
  });

  it("bounds the pool (LRU) and marks a re-added relay most-recent", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const f = fakeSocketFactory();
    const service = new RelayService({
      channel: workerCh,
      socketFactory: f.factory,
      storage: new MemoryStorage(),
      verify: () => true,
      now: () => NOW,
      maxGossipRelays: 2,
    });
    await service.start();
    const client = new LocalRelayClient(clientCh);
    const dataLayer = new DataLayer({ client, sign: async (t: EventTemplate) => makeEvent({ kind: t.kind }) });
    await settle();

    dataLayer.addGossipRelay("wss://a");
    dataLayer.addGossipRelay("wss://b");
    dataLayer.addGossipRelay("wss://a"); // re-add → most-recent → [b, a]
    dataLayer.addGossipRelay("wss://c"); // overflow → evict oldest (b) → [a, c]
    await settle();

    expect((await dataLayer.diagnostics()).gossipRelays).toEqual(["wss://a", "wss://c"]);
  });
});

describe("DataLayer per-interest relay hints", () => {
  const reqSub = (sock: { sent: any[] }) => sock.sent.find((m) => m[0] === "REQ")![1] as string;

  it("routes an AUTHOR-SCOPED read to a relay hint even when the author has no kind-10002", async () => {
    // The failing production case: a form's signing key has no outbox (kind-10002),
    // so the outbox partition would fall back to user relays only and never touch
    // the relays in the form's naddr. The hint must fold into that floor.
    const { f, service, dataLayer } = await wire();
    dataLayer.observe(
      [{ kinds: [30168], authors: ["formkey"], "#d": ["abc"] }],
      { onEvent: () => {} },
      { relays: ["wss://form-relay"] },
    );
    await settle();

    expect(f.count("wss://form-relay")).toBe(1); // dialed the hinted relay
    const sock = f.last("wss://form-relay");
    sock.open();
    expect(sock.sent.find((m) => m[0] === "REQ")![2]).toEqual({
      kinds: [30168],
      authors: ["formkey"],
      "#d": ["abc"],
    });
    sock.emit([
      "EVENT",
      reqSub(sock),
      makeEvent({ id: "f".repeat(64), kind: 30168, pubkey: "formkey", tags: [["d", "abc"]] }),
    ]);
    await settle();
    expect(service.db.getById("f".repeat(64))).toBeDefined(); // fetched + ingested
  });

  it("adds a relay hint to an AUTHOR-LESS read's relay set (alongside user relays)", async () => {
    const { f, dataLayer } = await wire();
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }, { relays: ["wss://hint"] });
    await settle();

    expect(f.count("wss://hint")).toBe(1); // the hint
    expect(f.count("wss://u1")).toBe(1); // and the user relay
  });

  it("unions the hints of two same-filter interests into ONE upstream subscription", async () => {
    const { dataLayer } = await wire();
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }, { relays: ["wss://a"] });
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }, { relays: ["wss://b"] });
    await settle();

    const diag = await dataLayer.diagnostics();
    const scope = diag.upstream.filter((u) =>
      u.filters.some((flt) => (flt.kinds ?? []).includes(1)),
    );
    expect(scope).toHaveLength(1); // deduped by filter-hash to one scope
    expect(scope[0].relays).toEqual(
      expect.arrayContaining(["wss://a", "wss://b", "wss://u1"]),
    );
  });

  it("does not touch the global gossip pool (hints are per-interest)", async () => {
    const { dataLayer } = await wire();
    dataLayer.observe([{ kinds: [1] }], { onEvent: () => {} }, { relays: ["wss://hint"] });
    await settle();
    expect((await dataLayer.diagnostics()).gossipRelays).toEqual([]);
  });
});
