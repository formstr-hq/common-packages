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
