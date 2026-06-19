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
