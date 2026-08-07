import { RelayService } from "./RelayService";
import { LocalRelayClient } from "./transport/LocalRelayClient";
import { createChannelPair } from "./transport/channel";
import { MemoryStorage } from "./storage/MemoryStorage";
import { fakeSocketFactory, makeEvent } from "./testkit";

const NOW = 1_000_000;
// Exceeds SyncEngine's 50ms ingest flush and lets channel microtasks run.
const settle = () => new Promise((r) => setTimeout(r, 80));

const reqOn = (sock: { sent: any[] }) => sock.sent.filter((m) => m[0] === "REQ");
const closeOn = (sock: { sent: any[] }) => sock.sent.filter((m) => m[0] === "CLOSE");

async function wire(extra: Partial<ConstructorParameters<typeof RelayService>[0]> = {}) {
  const { client: clientCh, worker: workerCh } = createChannelPair();
  const f = fakeSocketFactory();
  const service = new RelayService({
    channel: workerCh,
    socketFactory: f.factory,
    storage: new MemoryStorage(),
    verify: () => true,
    now: () => NOW,
    ...extra,
  });
  await service.start();
  // Synchronous teardown for these tests — they assert unobserve → upstream close
  // directly. The deferred-teardown grace is covered separately in the client
  // protocol suite.
  const client = new LocalRelayClient(clientCh, { unobserveGraceMs: 0 });
  client.setUserRelays(["wss://u1"]);
  await settle();
  return { f, service, client };
}

describe("RelayService — interests drive the network (app cannot)", () => {
  it("localOnly observe hits no network; a sync interest drives upstream and events flow back", async () => {
    const { f, service, client } = await wire();
    const filters = [{ kinds: [1], authors: ["alice"] }];

    const got: string[] = [];
    let eosed = false;
    client.observe(filters, { onEvent: (e) => got.push(e.id), onEose: () => (eosed = true) }, { localOnly: true });
    await settle();

    expect(eosed).toBe(true); // local EOSE immediately
    expect(f.count("wss://u1")).toBe(0); // localOnly opened NO socket

    // A sync interest (default) is what reaches the network.
    client.observe(filters, { onEvent: () => {} });
    await settle();
    expect(f.count("wss://u1")).toBe(1);

    const sock = f.last("wss://u1");
    sock.open();
    const subId = reqOn(sock)[0][1];
    sock.emit(["EVENT", subId, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice" })]);
    await settle();

    expect(got).toEqual(["a".repeat(64)]); // upstream → store → all matching local interests
    expect(service.db.getById("a".repeat(64))).toBeDefined();
  });

  it("routes via outbox when the author's kind-10002 is in the store", async () => {
    const { f, service, client } = await wire();
    service.db.add(
      makeEvent({ id: "r".repeat(64), kind: 10002, pubkey: "alice", tags: [["r", "wss://alice-relay"]] })
    );
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://alice-relay")).toBe(1);
  });

  it("dedupes by scope: N interests on the same scope share ONE upstream subscription", async () => {
    const { f, client } = await wire();
    const filters = [{ kinds: [1], authors: ["alice"] }];

    const a = client.observe(filters, { onEvent: () => {} });
    const b = client.observe(filters, { onEvent: () => {} }); // same scope
    await settle();
    f.last("wss://u1").open();
    expect(reqOn(f.last("wss://u1"))).toHaveLength(1); // ONE upstream REQ, not two

    a.unobserve();
    await settle();
    expect(closeOn(f.last("wss://u1"))).toHaveLength(0); // still wanted by b

    b.unobserve(); // last interest leaves
    await settle();
    expect(closeOn(f.last("wss://u1"))).toHaveLength(1);
  });

  it("enriches: a synced event's referenced id + author profile are fetched on the worker's own affordance", async () => {
    const { f, service, client } = await wire();
    const refId = "f".repeat(64);
    const noteId = "a".repeat(64);
    // Sync interest for alice's notes → upstream read on the user's relay.
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const syncSub = reqOn(sock)[0][1];

    // A note referencing an unknown event, from an author with no cached profile.
    sock.emit(["EVENT", syncSub, makeEvent({ id: noteId, kind: 1, pubkey: "alice", tags: [["e", refId]] })]);
    // Wait past the 200ms enrichment debounce.
    await new Promise((r) => setTimeout(r, 300));

    // The worker opened a follow-up read for the missing ref + author profile.
    const reqs = reqOn(sock);
    const enrichReq = reqs.find((m) => m[1] !== syncSub);
    expect(enrichReq).toBeDefined();
    const enrichFilters = enrichReq!.slice(2);
    expect(enrichFilters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ids: [refId] }),
        expect.objectContaining({ kinds: [0], authors: ["alice"] }),
      ])
    );

    // Enrichment results land in the store, cache-only reads can now find them.
    const enrichSub = enrichReq![1];
    sock.emit(["EVENT", enrichSub, makeEvent({ id: refId, kind: 1, pubkey: "bob" })]);
    sock.emit(["EVENT", enrichSub, makeEvent({ id: "b".repeat(64), kind: 0, pubkey: "alice", content: "{}" })]);
    await settle();
    expect(service.db.getById(refId)).toBeDefined();
    expect(service.db.query({ kinds: [0], authors: ["alice"] })).toHaveLength(1);
  });

  it("publish stores locally AND sends the event to the user's relays", async () => {
    const { f, service, client } = await wire();
    const ev = makeEvent({ id: "p".repeat(64), kind: 1, pubkey: "me" });

    client.publish(ev);
    await settle();

    expect(service.db.getById("p".repeat(64))).toBeDefined(); // stored locally
    const sock = f.last("wss://u1");
    sock.open(); // flush the queued publish
    expect(sock.sent.some((m) => m[0] === "EVENT" && m[1].id === "p".repeat(64))).toBe(true);
  });

  it("publishes a gift wrap to the recipient's kind-10050 DM inbox, NOT their read relays", async () => {
    const { f, service, client } = await wire();
    // Bob has both a general read relay (kind 10002) and a DM inbox (kind 10050).
    service.db.add(
      makeEvent({ kind: 10002, pubkey: "bob", tags: [["r", "wss://bob-read"]] })
    );
    service.db.add(
      makeEvent({ kind: 10050, pubkey: "bob", tags: [["relay", "wss://bob-inbox"]] })
    );

    const wrap = makeEvent({ id: "w".repeat(64), kind: 1059, pubkey: "ephemeral", tags: [["p", "bob"]] });
    client.publish(wrap);
    await settle();

    // Delivered to the DM inbox…
    expect(f.count("wss://bob-inbox")).toBe(1);
    const inbox = f.last("wss://bob-inbox");
    inbox.open();
    expect(inbox.sent.some((m) => m[0] === "EVENT" && m[1].id === wrap.id)).toBe(true);
    // …and NOT to bob's general read relay, nor spammed to the user's own relays.
    expect(f.count("wss://bob-read")).toBe(0);
    expect(f.count("wss://u1")).toBe(0);
  });

  it("routes a gift wrap to explicit relay hints (the sender-resolved recipient inbox)", async () => {
    const { f, client } = await wire();
    // No kind-10050 in the store: the sender supplies the recipient's inbox, as
    // an app that resolved it to compose the message would.
    const wrap = makeEvent({ id: "w".repeat(64), kind: 1059, pubkey: "ephemeral", tags: [["p", "carol"]] });
    client.publish(wrap, { relays: ["wss://carol-inbox"] });
    await settle();

    expect(f.count("wss://carol-inbox")).toBe(1);
    const inbox = f.last("wss://carol-inbox");
    inbox.open();
    expect(inbox.sent.some((m) => m[0] === "EVENT" && m[1].id === wrap.id)).toBe(true);
  });

  it("falls back to a gift-wrap recipient's kind-10002 read relays when they have no DM inbox", async () => {
    const { f, service, client } = await wire();
    // Erin published NIP-65 read relays but no kind-10050 DM inbox list.
    service.db.add(
      makeEvent({ kind: 10002, pubkey: "erin", tags: [["r", "wss://erin-read"]] })
    );
    const wrap = makeEvent({ id: "w".repeat(64), kind: 1059, pubkey: "ephemeral", tags: [["p", "erin"]] });
    client.publish(wrap);
    await settle();

    expect(f.count("wss://erin-read")).toBe(1);
    const sock = f.last("wss://erin-read");
    sock.open();
    expect(sock.sent.some((m) => m[0] === "EVENT" && m[1].id === wrap.id)).toBe(true);
    // The NIP-65 fallback stands in for the default — don't also spam user relays.
    expect(f.count("wss://u1")).toBe(0);
  });

  it("falls back to user relays for a gift wrap when no inbox is known or hinted", async () => {
    const { f, client } = await wire();
    const wrap = makeEvent({ id: "w".repeat(64), kind: 1059, pubkey: "ephemeral", tags: [["p", "dave"]] });
    client.publish(wrap);
    await settle();

    expect(f.count("wss://u1")).toBe(1); // best-effort: still goes somewhere
    const sock = f.last("wss://u1");
    sock.open();
    expect(sock.sent.some((m) => m[0] === "EVENT" && m[1].id === wrap.id)).toBe(true);
  });

  it("an author-less interest reads from the user's relays and ingests their events", async () => {
    const { f, service, client } = await wire();
    const got: string[] = [];
    client.observe([{ kinds: [1] }], { onEvent: (e) => got.push(e.id) }); // no authors → user relays
    await settle();
    expect(f.count("wss://u1")).toBe(1);

    const sock = f.last("wss://u1");
    sock.open();
    const sub = reqOn(sock)[0][1];
    sock.emit(["EVENT", sub, makeEvent({ id: "g".repeat(64), kind: 1, pubkey: "anyone" })]);
    await settle();
    expect(got).toEqual(["g".repeat(64)]);
    expect(service.db.getById("g".repeat(64))).toBeDefined();
  });

  it("reopens a standing author-less sub on the new relays when the user relay set changes", async () => {
    const { f, client } = await wire(); // userRelays = ["wss://u1"]
    // An author-less interest (e.g. the kind-1059 DM stream) opens on user relays.
    client.observe([{ kinds: [1059] }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://u1")).toBe(1);
    expect(f.count("wss://dm-inbox")).toBe(0);

    // The user's NIP-17 DM inbox relay folds in (e.g. after store hydration). The
    // standing sub must reopen on the wider set, else DMs delivered only to
    // wss://dm-inbox never arrive live — reconcile() alone wouldn't, since the
    // filter hash is unchanged.
    client.setUserRelays(["wss://u1", "wss://dm-inbox"]);
    await settle();

    expect(f.count("wss://dm-inbox")).toBe(1); // now subscribed on the new relay
    const dmSock = f.last("wss://dm-inbox");
    dmSock.open();
    const reqs = reqOn(dmSock);
    expect(reqs).toHaveLength(1);
    expect(reqs[0][2]).toMatchObject({ kinds: [1059] });
  });

  it("an unchanged user relay set does not reopen standing subs", async () => {
    const { f, client } = await wire(); // userRelays = ["wss://u1"]
    client.observe([{ kinds: [1059] }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://u1")).toBe(1);

    // Same set (different order) → no teardown/reopen churn.
    client.setUserRelays(["wss://u1"]);
    await settle();
    expect(f.count("wss://u1")).toBe(1);
    expect(closeOn(f.last("wss://u1"))).toHaveLength(0);
  });

  it("routes the kind-1059 DM stream to the DM inbox relays", async () => {
    const { f, client } = await wire(); // userRelays = ["wss://u1"]
    client.setDmRelays(["wss://dm1"]);
    await settle();

    client.observe([{ kinds: [1059] }], { onEvent: () => {} });
    await settle();

    expect(f.count("wss://dm1")).toBe(1); // DM inbox relay subscribed
    const sock = f.last("wss://dm1");
    sock.open();
    expect(reqOn(sock)[0][2]).toMatchObject({ kinds: [1059] });
  });

  it("keeps a general (non-DM) author-less feed read off the DM inbox relays", async () => {
    const { f, service, client } = await wire();
    client.setDmRelays(["wss://dm1"]);
    await settle();

    const got: string[] = [];
    client.observe([{ kinds: [1] }], { onEvent: (e) => got.push(e.id) });
    await settle();
    expect(f.count("wss://u1")).toBe(1); // general read relay
    expect(f.count("wss://dm1")).toBe(0); // never the DM inbox relay

    // The relay it DID open on is recorded as where the event was seen.
    const sock = f.last("wss://u1");
    sock.open();
    const id = "g".repeat(64);
    sock.emit(["EVENT", reqOn(sock)[0][1], makeEvent({ id, kind: 1, pubkey: "anyone" })]);
    await settle();
    expect(got).toEqual([id]);
    expect(await client.seenOn(id)).toEqual(["wss://u1"]);
    expect(service.db.getById(id)).toBeDefined();
  });

  it("reopens the DM stream on the new inbox relay when the DM relay set changes", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1059] }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://dm2")).toBe(0);

    client.setDmRelays(["wss://dm2"]); // inbox relay learned after hydration
    await settle();
    expect(f.count("wss://dm2")).toBe(1);
    const sock = f.last("wss://dm2");
    sock.open();
    expect(reqOn(sock)[0][2]).toMatchObject({ kinds: [1059] });
  });

  it("reports an event's source relays via seenOn (outbox path), empty for unknown ids", async () => {
    const { f, service, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const id = "a".repeat(64);
    sock.emit(["EVENT", reqOn(sock)[0][1], makeEvent({ id, kind: 1, pubkey: "alice" })]);
    await settle();

    expect(service.db.getById(id)).toBeDefined();
    expect(await client.seenOn(id)).toEqual(["wss://u1"]);
    expect(await client.seenOn("z".repeat(64))).toEqual([]); // not stored
  });

  it("ignores a relay-set change while paused — opens no sockets until resume", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1059] }], { onEvent: () => {} });
    await settle();
    client.pause();
    await settle();

    client.setDmRelays(["wss://dm9"]); // inbox relay learned while backgrounded
    await settle();
    expect(f.count("wss://dm9")).toBe(0); // reopen short-circuits while paused

    client.resume();
    await settle();
    expect(f.count("wss://dm9")).toBe(1); // reconnects from standing interests on resume
  });

  it("drops an author-less event that fails signature verification", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const f = fakeSocketFactory();
    const service = new RelayService({
      channel: workerCh,
      socketFactory: f.factory,
      storage: new MemoryStorage(),
      verify: () => false, // reject everything
      now: () => NOW,
    });
    await service.start();
    const client = new LocalRelayClient(clientCh);
    client.setUserRelays(["wss://u1"]);
    await settle();

    client.observe([{ kinds: [1] }], { onEvent: () => {} }); // author-less
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    sock.emit(["EVENT", reqOn(sock)[0][1], makeEvent({ id: "v".repeat(64), kind: 1, pubkey: "x" })]);
    await settle();

    expect(service.db.getById("v".repeat(64))).toBeUndefined(); // unverified → not stored
    await service.stop();
  });

  it("counts a relay that accepts a publish as having seen the event", async () => {
    const { f, client } = await wire();
    const id = "p".repeat(64);
    client.publish(makeEvent({ id, kind: 1, pubkey: "me" }));
    await settle();
    const sock = f.last("wss://u1");
    sock.open(); // flush the queued publish
    sock.emit(["OK", id, true, ""]); // relay accepts → it now holds the event
    await settle();
    expect(await client.seenOn(id)).toEqual(["wss://u1"]);
  });

  it("for an own note, seenOn is the set of relays that ACCEPTED the publish (not the rejecters)", async () => {
    const { f, client } = await wire();
    client.setUserRelays(["wss://u1", "wss://u2", "wss://u3"]); // fan out to three
    await settle();

    const id = "p".repeat(64);
    client.publish(makeEvent({ id, kind: 1, pubkey: "me" }));
    await settle();

    for (const url of ["wss://u1", "wss://u2", "wss://u3"]) f.last(url).open();
    f.last("wss://u1").emit(["OK", id, true, ""]); // accepted → has it
    f.last("wss://u2").emit(["OK", id, false, "blocked: spam"]); // rejected → does NOT
    f.last("wss://u3").emit(["OK", id, true, ""]); // accepted → has it
    await settle();

    // Authoritative for own notes: every accepter, none of the rejecters.
    expect((await client.seenOn(id)).sort()).toEqual(["wss://u1", "wss://u3"]);
  });

  it("publish also targets a mentioned pubkey's inbox (read) relays", async () => {
    const { f, service, client } = await wire();
    // bob advertises an inbox relay via a read-marked NIP-65 entry. The junk
    // tags (a non-"r" tag and an "r" tag with no url) must be skipped.
    service.db.add(
      makeEvent({
        id: "b".repeat(64),
        kind: 10002,
        pubkey: "bob",
        tags: [["name", "bob"], ["r"], ["r", "wss://bob-inbox", "read"]],
      })
    );
    client.publish(makeEvent({ id: "m".repeat(64), kind: 1, pubkey: "me", tags: [["p", "bob"]] }));
    await settle();

    expect(f.count("wss://bob-inbox")).toBe(1); // gossip-routed to the recipient's inbox
    f.last("wss://bob-inbox").open();
    expect(f.last("wss://bob-inbox").sent.some((m) => m[0] === "EVENT" && m[1].id === "m".repeat(64))).toBe(true);
  });
});

describe("RelayService — NIP-50 search routing", () => {
  it("uses dedicated search relays before author/outbox routing and filters leaks", async () => {
    const { f, service, client } = await wire();
    service.db.add(
      makeEvent({
        id: "r".repeat(64),
        kind: 10002,
        pubkey: "alice",
        tags: [["r", "wss://alice-relay"]],
      }),
    );
    client.setSearchRelays(["wss://search"]);
    const got: string[] = [];
    client.observe(
      [{ kinds: [0], authors: ["alice"], search: "alice" }],
      { onEvent: (event) => got.push(event.id) },
    );
    await settle();

    expect(f.count("wss://search")).toBe(1);
    expect(f.count("wss://alice-relay")).toBe(0);
    expect(f.count("wss://u1")).toBe(0);

    const sock = f.last("wss://search");
    sock.open();
    const subId = reqOn(sock)[0][1];
    const unrelated = makeEvent({
      id: "x".repeat(64),
      kind: 0,
      pubkey: "alice",
      content: '{"name":"Bob"}',
    });
    const matching = makeEvent({
      id: "m".repeat(64),
      kind: 0,
      pubkey: "alice",
      created_at: 1001,
      content: '{"name":"Alice"}',
    });
    sock.emit(["EVENT", subId, unrelated]);
    await settle();
    expect(service.db.getById(unrelated.id)).toBeUndefined();
    sock.emit(["EVENT", subId, matching]);
    await settle();

    expect(got).toEqual([matching.id]);
    expect(service.db.getById(matching.id)).toBeDefined();
    expect(await client.seenOn(matching.id)).toEqual(["wss://search"]);
    expect((await client.diagnostics()).searchRelays).toEqual(["wss://search"]);
  });

  it("falls back to ordinary read relays when no search relays are configured", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [0], search: "alice" }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://u1")).toBe(1);
  });

  it("reopens a standing search interest when the dedicated set changes", async () => {
    const { f, client } = await wire();
    client.setSearchRelays(["wss://search-1"]);
    client.observe([{ kinds: [0], search: "alice" }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://search-1")).toBe(1);
    const first = f.last("wss://search-1");
    first.open();

    client.setSearchRelays(["wss://search-2"]);
    await settle();
    expect(closeOn(first)).toHaveLength(1);
    expect(f.count("wss://search-2")).toBe(1);
  });
});

describe("RelayService — construction & teardown", () => {
  it("runs without a storage adapter (persistence is a no-op)", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const f = fakeSocketFactory();
    const service = new RelayService({ channel: workerCh, socketFactory: f.factory, verify: () => true });
    await service.start(); // no storage → nothing to hydrate

    const client = new LocalRelayClient(clientCh);
    client.publish(makeEvent({ id: "n".repeat(64), kind: 1, pubkey: "me" }));
    await settle();
    expect(service.db.getById("n".repeat(64))).toBeDefined();

    await service.stop(); // null persistence path
  });

  it("uses the default verify + clock when neither is injected", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const f = fakeSocketFactory();
    // No `verify`, no `now` → constructor falls back to nostr-tools verify + Date.now.
    const service = new RelayService({ channel: workerCh, socketFactory: f.factory, storage: new MemoryStorage() });
    await service.start();
    const client = new LocalRelayClient(clientCh);
    client.setUserRelays(["wss://u1"]);
    await settle();

    // publish exercises the default clock (per-relay latency timing).
    client.publish(makeEvent({ id: "p".repeat(64), kind: 1, pubkey: "me" }));
    await settle();
    f.last("wss://u1").open();
    expect(service.db.getById("p".repeat(64))).toBeDefined();
    await service.stop();
  });

  it("re-declaring an interest via update() widens the upstream window", async () => {
    const { f, client } = await wire();
    const handle = client.observe([{ kinds: [1], authors: ["alice"], limit: 10 }], { onEvent: () => {} });
    await settle();
    f.last("wss://u1").open();

    handle.update([{ kinds: [1], authors: ["alice"], until: 5000, limit: 20 }]); // page older
    await settle();
    // The worker reconciled to a new scope: a second REQ went out for the wider window.
    const reqs = reqOn(f.last("wss://u1"));
    expect(reqs.length).toBeGreaterThanOrEqual(2);
  });

  it("stop() tears down sockets, interests, and a pending enrichment timer", async () => {
    const { f, service, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const syncSub = reqOn(sock)[0][1];
    // A note with an unknown ref schedules enrichment (200ms debounce).
    sock.emit(["EVENT", syncSub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] })]);
    await settle(); // past the 50ms ingest flush → enrich timer is now pending

    await service.stop();
    expect(f.last("wss://u1").readyState).toBe(3); // every socket destroyed
  });

  it("pause clears a pending enrichment timer", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const syncSub = reqOn(sock)[0][1];
    sock.emit(["EVENT", syncSub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] })]);
    await settle(); // enrich timer pending

    client.pause(); // must clear the enrich timer (and close sockets)
    await settle();
    expect(f.last("wss://u1").readyState).toBe(3);
  });

  it("defaults to the real WebSocket factory when none is injected", async () => {
    // No socketFactory → falls back to webSocketFactory. We never observe, so no
    // real socket is opened; this just exercises the default-factory branch.
    const { worker: workerCh } = createChannelPair();
    const service = new RelayService({ channel: workerCh, storage: new MemoryStorage(), verify: () => true });
    await service.start();
    expect(service.db.allEvents()).toHaveLength(0);
    await service.stop();
  });
});

describe("RelayService — edge branches", () => {
  it("a paused worker ignores new interests until resumed", async () => {
    const { f, client } = await wire();
    client.pause();
    await settle();
    // observe → reconcile, but paused short-circuits: no socket opens.
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    expect(f.count("wss://u1")).toBe(0);

    client.resume();
    await settle();
    expect(f.count("wss://u1")).toBe(1); // resume reopens from the standing interest
  });

  it("resume while not paused is a no-op", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    client.resume(); // not paused → returns immediately, nothing reopens
    await settle();
    expect(f.count("wss://u1")).toBe(1);
  });

  it("resume drains enrichment queued while paused", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const syncSub = reqOn(sock)[0][1];
    // Synced note refs an unknown event → enrichment is queued.
    sock.emit(["EVENT", syncSub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] })]);
    await new Promise((r) => setTimeout(r, 60)); // past the 50ms ingest flush

    client.pause(); // clears the enrich timer with targets still queued
    await settle();
    client.resume(); // must reschedule the drain
    await settle();
    f.last("wss://u1").open(); // open the fresh post-resume socket
    await new Promise((r) => setTimeout(r, 300)); // past the 200ms enrich debounce

    // The queued enrichment fetch (an ids/kind-0 filter) went out after resume.
    const enrichReq = reqOn(f.last("wss://u1")).find((m) =>
      m.slice(2).some((flt: any) => Array.isArray(flt.ids) || (flt.kinds && flt.kinds[0] === 0))
    );
    expect(enrichReq).toBeDefined();
  });

  it("enriches q-tagged quotes and unsubscribes the enrich sub on EOSE", async () => {
    const { f, service, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const syncSub = reqOn(sock)[0][1];
    const quoteId = "9".repeat(64);
    // A "q" (quote) tag is enriched just like an "e" reference; the empty "e"
    // tag must be ignored.
    sock.emit(["EVENT", syncSub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["q", quoteId], ["e", ""]] })]);
    await new Promise((r) => setTimeout(r, 300));

    const enrichReq = reqOn(sock).find((m) => m[1] !== syncSub);
    expect(enrichReq!.slice(2)).toEqual(expect.arrayContaining([expect.objectContaining({ ids: [quoteId] })]));

    // EOSE on the enrichment sub closes it (the onEose → unsubscribe path).
    const enrichSub = enrichReq![1];
    sock.emit(["EOSE", enrichSub]);
    await settle();
    expect(closeOn(sock).some((m) => m[1] === enrichSub)).toBe(true);
    expect(service.db.allEvents().length).toBeGreaterThan(0);
  });

  it("coalesces enrichment scheduling across rapid ingests into one fetch", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const sub = reqOn(sock)[0][1];

    sock.emit(["EVENT", sub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] })]);
    await new Promise((r) => setTimeout(r, 60)); // flush 1 → enrich timer scheduled
    sock.emit(["EVENT", sub, makeEvent({ id: "b".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "g".repeat(64)]] })]);
    await new Promise((r) => setTimeout(r, 60)); // flush 2 → timer already pending (no reschedule)
    await new Promise((r) => setTimeout(r, 220)); // enrich debounce elapses → one batched fetch

    const enrichReq = reqOn(sock).find((m) => m[1] !== sub);
    expect(enrichReq).toBeDefined();
    const ids = enrichReq!.slice(2).flatMap((flt: any) => flt.ids ?? []);
    expect(ids).toEqual(expect.arrayContaining(["f".repeat(64), "g".repeat(64)])); // both refs in one fetch
  });

  it("skips the enrichment fetch when no user relays are configured", async () => {
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
    // No setUserRelays — alice still routes via her own outbox relay.
    service.db.add(makeEvent({ id: "r".repeat(64), kind: 10002, pubkey: "alice", tags: [["r", "wss://alice-relay"]] }));
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://alice-relay");
    sock.open();
    const sub = reqOn(sock)[0][1];
    sock.emit(["EVENT", sub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: [["e", "f".repeat(64)]] })]);
    await new Promise((r) => setTimeout(r, 300)); // enrich would flush here — but there are no user relays

    expect(reqOn(sock)).toHaveLength(1); // only the original sync REQ; no enrichment fetch
    await service.stop();
  });

  it("drains enrichment in capped batches when a burst exceeds the per-flush cap", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const sub = reqOn(sock)[0][1];

    // One note referencing 201 distinct events → exceeds the 200-per-flush cap,
    // so the worker drains a first batch and re-schedules the remainder.
    const refs = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(64, "0"));
    sock.emit(["EVENT", sub, makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "alice", tags: refs.map((r) => ["e", r]) })]);
    await new Promise((r) => setTimeout(r, 600)); // two enrich debounce windows

    const enrichIds = reqOn(sock)
      .filter((m) => m[1] !== sub)
      .flatMap((m) => m.slice(2).flatMap((flt: any) => flt.ids ?? []));
    expect(enrichIds.length).toBe(201); // every ref fetched across multiple batches
  });

  it("an id-only interest (no kinds) reads and ingests, then closes on unobserve", async () => {
    const { f, service, client } = await wire();
    const wanted = "c".repeat(64);
    const handle = client.observe([{ ids: [wanted] }], { onEvent: () => {} }); // author-less, no kinds
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    const sub = reqOn(sock)[0][1];
    sock.emit(["EVENT", sub, makeEvent({ id: wanted, kind: 1, pubkey: "anyone" })]);
    await settle();
    expect(service.db.getById(wanted)).toBeDefined();

    handle.unobserve(); // exercises the author-less handle's close()
    await settle();
    expect(closeOn(sock).some((m) => m[1] === sub)).toBe(true);
  });
});

describe("RelayService — lifecycle", () => {
  it("pause closes all sockets; resume reconnects from standing interests", async () => {
    const { f, client } = await wire();
    client.observe([{ kinds: [1], authors: ["alice"] }], { onEvent: () => {} });
    await settle();
    f.last("wss://u1").open();
    expect(f.last("wss://u1").readyState).toBe(1);

    client.pause();
    await settle();
    expect(f.last("wss://u1").readyState).toBe(3); // socket closed

    client.resume();
    await settle();
    expect(f.count("wss://u1")).toBe(2); // a fresh socket was created
    f.last("wss://u1").open();
    expect(reqOn(f.last("wss://u1"))).toHaveLength(1); // interest re-established
  });
});

describe("RelayService — durable outbox (delivery on reconnect)", () => {
  const okSock = (sock: { sent: any[] }, id: string) =>
    sock.sent.some((m) => m[0] === "EVENT" && m[1].id === id);

  it("queues publishes that time out as delivery debt (and reschedules across marks)", async () => {
    const { service, client } = await wire({ publishTimeoutMs: 20 });
    client.publish(makeEvent({ id: "a".repeat(64), kind: 1, pubkey: "me" }));
    client.publish(makeEvent({ id: "b".repeat(64), kind: 1, pubkey: "me" }));
    await settle(); // > publishTimeoutMs, relay never sends OK → both owed

    const diag = await client.diagnostics();
    expect(diag.delivery.pendingRelays).toBe(2);
    expect(diag.delivery.records.map((r) => r.eventId).sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(diag.delivery.records[0].pending).toEqual(["wss://u1"]);

    await service.stop(); // tears down with the retry timer still armed
  });

  it("redelivers owed events when the relay comes back (resume re-attempts)", async () => {
    let clock = NOW;
    const { f, service, client } = await wire({
      publishTimeoutMs: 50,
      now: () => clock,
      outbox: { baseBackoffMs: 1000 },
    });
    const id = "a".repeat(64);
    client.publish(makeEvent({ id, kind: 1, pubkey: "me" }));
    await new Promise((r) => setTimeout(r, 150)); // times out → owed (backed off to +1000)
    expect((await client.diagnostics()).delivery.pendingRelays).toBe(1);

    client.pause(); // tears down the socket + retry timer
    await settle();
    clock += 2000; // time passes while offline → the debt is due again
    client.resume(); // re-attempts the debt on a fresh connection
    await settle();

    const sock = f.last("wss://u1");
    sock.open();
    expect(okSock(sock, id)).toBe(true); // the event was re-sent
    sock.emit(["OK", id, true, ""]); // now it lands
    await settle();

    expect((await client.diagnostics()).delivery.pendingRelays).toBe(0); // debt cleared
    expect(await client.seenOn(id)).toContain("wss://u1");
    await service.stop();
  });

  it("a deletion of the event also clears its outbox debt", async () => {
    const { service, client } = await wire({ publishTimeoutMs: 20 });
    const id = "a".repeat(64);
    client.publish(makeEvent({ id, kind: 1, pubkey: "me" }));
    await settle();
    expect((await client.diagnostics()).delivery.pendingRelays).toBe(1);

    // Author deletes the event (NIP-09) → store remove → outbox debt dropped.
    service.db.add(makeEvent({ kind: 5, pubkey: "me", tags: [["e", id]] }));
    await settle();
    expect((await client.diagnostics()).delivery.pendingRelays).toBe(0);
    await service.stop();
  });

  it("marks delivery FAILED after the give-up cap, then retryDelivery re-arms it", async () => {
    const { f, service, client } = await wire({ publishTimeoutMs: 300, outbox: { maxAttempts: 1 } });
    const id = "a".repeat(64);
    client.publish(makeEvent({ id, kind: 1, pubkey: "me" }));
    // Initial publish times out → mark; the immediate auto-retry also times out →
    // attempts hits the cap of 1 → failed (both at the 300ms publish deadline).
    await new Promise((r) => setTimeout(r, 800));

    let diag = await client.diagnostics();
    expect(diag.delivery.failed).toBe(1);
    expect(diag.delivery.pendingRelays).toBe(0); // failed isn't counted as pending

    // Manual retry re-arms it; this time we let the relay accept (well inside the
    // 300ms deadline).
    client.retryDelivery(id);
    await settle();
    const sock = f.last("wss://u1");
    sock.open();
    sock.emit(["OK", id, true, ""]);
    await settle();

    diag = await client.diagnostics();
    expect(diag.delivery.failed).toBe(0);
    expect(diag.delivery.pendingRelays).toBe(0);
    expect(await client.seenOn(id)).toContain("wss://u1");
    await service.stop();
  });
});

describe("RelayService — online state", () => {
  it("online tracks user-relay connectivity with a 30s debounce window", async () => {
    let clock = NOW;
    const { f, service, client } = await wire({ now: () => clock });

    expect(await client.online()).toBe(false); // nothing connected yet

    client.observe([{ kinds: [1] }], { onEvent: () => {} }); // opens a user-relay socket
    await settle();
    f.last("wss://u1").open(); // onConnect → marks reachability
    await settle();
    expect(await client.online()).toBe(true);

    f.last("wss://u1").close(); // socket drops…
    await settle();
    expect(await client.online()).toBe(true); // …but still within the 30s window

    clock += 31_000; // window elapses with no reconnect
    expect(await client.online()).toBe(false);
    await service.stop();
  });
});
