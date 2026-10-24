import type { Event, Filter } from "nostr-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWebSocketImplementation } from "nostr-tools/pool";
import {
  createFileShare,
  createRelayPoolStore,
  DriveKeyMintRefusedError,
  driveKeyEntry,
  fetchFiles,
  listShares,
  mintDriveKey,
  renameFile,
  resolveDriveKeyStatus,
  resolveShare,
  revokeShare,
  uploadFile,
  type BlossomTransport,
  type DriveKeyring,
  type FileEntry,
  type RelayPoolLike,
  type RelayPoolStore,
} from "../src/index.js";
import { FakeNetwork, n } from "./fake-network.js";
import { flush, makeIdentity } from "./helpers.js";

// The real nostr-tools pool is only constructed, never connected. useWebSocketImplementation is spied so
// the `webSocket` option can be checked without changing process-wide state.
vi.mock("nostr-tools/pool", async (importOriginal) => ({
  ...(await importOriginal<typeof import("nostr-tools/pool")>()),
  useWebSocketImplementation: vi.fn(),
}));

const R1 = "wss://relay.one";
const R2 = "wss://relay.two";
const R3 = "wss://relay.three";

const stores: RelayPoolStore[] = [];
function storeOn(net: FakeNetwork, relays: string[] = [R1, R2], extra: Partial<Parameters<typeof createRelayPoolStore>[0]> = {}) {
  const pool = net.pool();
  const store = createRelayPoolStore({ relays, pool, eoseTimeoutMs: 40, publishTimeoutMs: 40, ...extra });
  stores.push(store);
  return { store, pool };
}
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

const sk = (id: string, pubkey: string, kind: number, createdAt = 1): Event =>
  ({ id: id.repeat(64).slice(0, 64), pubkey, kind, created_at: createdAt, tags: [["d", "x"]], content: "", sig: "0".repeat(128) });

function collect(store: RelayPoolStore, filters: Filter[], options?: { localOnly?: boolean; relays?: string[] }) {
  const events: Event[] = [];
  let eose = 0;
  const handle = store.observe(filters, { onEvent: (e) => events.push(e), onEose: () => { eose += 1; } }, options);
  return { events, handle, eoseCount: () => eose };
}

describe("relay set", () => {
  it("normalizes and de-duplicates the defaults, and exposes them as `relays`", () => {
    const { store } = storeOn(new FakeNetwork(), [R1, `${R1}/`, "WSS://Relay.One", R2]);
    expect(store.relays).toEqual([n(R1), n(R2)]);
  });

  it("per-call hints are added to the defaults, never replace them, and bad hints are ignored", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net, [R1]);
    collect(store, [{ kinds: [1] }], { relays: [R3, "not a url", R1] });
    await flush();
    expect(net.subscribeCalls[0]!.relays).toEqual([n(R1), n(R3)]);
  });
});

describe("observe", () => {
  it("delivers each matching event once, even when several relays carry it, then reports EOSE", async () => {
    const net = new FakeNetwork();
    const e1 = sk("a", "p".repeat(64), 1);
    const e2 = sk("b", "p".repeat(64), 7);
    net.seed(R1, e1, e2).seed(R2, e1);
    const { store } = storeOn(net);
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    expect(got.events.map((e) => e.id)).toEqual([e1.id]);
    expect(got.eoseCount()).toBe(1);
  });

  it("with several filters, one subscription each, and EOSE only once all have reported", async () => {
    const net = new FakeNetwork().seed(R1, sk("a", "p".repeat(64), 1), sk("b", "p".repeat(64), 2));
    const { store } = storeOn(net, [R1]);
    const got = collect(store, [{ kinds: [1] }, { kinds: [2] }]);
    await flush();
    expect(net.subscribeCalls).toHaveLength(2);
    expect(got.events).toHaveLength(2);
    expect(got.eoseCount()).toBe(1);
  });

  it("a silent relay cannot hang the caller: EOSE arrives after the timeout, with what the others sent", async () => {
    const net = new FakeNetwork().seed(R1, sk("a", "p".repeat(64), 1));
    net.silent.add(n(R2));
    const { store } = storeOn(net);
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    expect(got.eoseCount()).toBe(0);
    await vi.waitFor(() => expect(got.eoseCount()).toBe(1));
    expect(got.events).toHaveLength(1);
  });

  it("an interest on a single filter reports EOSE exactly once, whether by EOSE or by relays closing", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net, [R1]);
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(got.eoseCount()).toBe(1);
  });

  it("serves localOnly reads from the cache without touching the network", async () => {
    const net = new FakeNetwork().seed(R1, sk("a", "p".repeat(64), 1));
    const { store } = storeOn(net);
    const warm = collect(store, [{ kinds: [1] }]);
    await flush();
    expect(warm.events).toHaveLength(1);
    const calls = net.subscribeCalls.length;

    const cold = collect(store, [{ kinds: [1] }], { localOnly: true });
    await flush();
    expect(cold.events.map((e) => e.id)).toEqual(warm.events.map((e) => e.id));
    expect(cold.eoseCount()).toBe(1);
    expect(net.subscribeCalls.length).toBe(calls);
  });

  it("replays cached events first, so a write is visible to the next read before any relay echoes it", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net);
    const event = sk("c", "p".repeat(64), 1);
    await store.publishEvent(event);
    net.relays.forEach((events) => events.clear()); // relays "forgot" it
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    expect(got.events.map((e) => e.id)).toEqual([event.id]);
  });

  it("handles an empty relay list and an empty filter list without hanging", async () => {
    const none = storeOn(new FakeNetwork(), []);
    const a = collect(none.store, [{ kinds: [1] }]);
    await flush();
    expect(a.eoseCount()).toBe(1);
    const b = collect(storeOn(new FakeNetwork()).store, []);
    await flush();
    expect(b.eoseCount()).toBe(1);
  });

  it("unobserve stops delivery and closes the subscriptions; calling it twice is safe", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net);
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    got.handle.unobserve();
    got.handle.unobserve();
    await store.publishEvent(sk("d", "p".repeat(64), 1));
    expect(got.events).toHaveLength(0);
    const local = collect(store, [{ kinds: [1] }], { localOnly: true });
    local.handle.unobserve();
  });

  it("an observer opened after close() delivers nothing", async () => {
    const { store } = storeOn(new FakeNetwork().seed(R1, sk("a", "p".repeat(64), 1)));
    store.close();
    const got = collect(store, [{ kinds: [1] }]);
    await flush();
    expect(got.events).toEqual([]);
  });
});

describe("publishEvent", () => {
  it("reports each relay honestly: accepted, rejected with its reason, or timed out", async () => {
    const net = new FakeNetwork();
    net.refusing.set(n(R2), "blocked: not on allowlist");
    net.silent.add(n(R3));
    const { store } = storeOn(net, [R1, R2, R3]);
    const result = await store.publishEvent(sk("a", "p".repeat(64), 1));
    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ accepted: 1, total: 3 });
    expect(result.relayResults).toEqual([
      { relay: n(R1), status: "accepted" },
      { relay: n(R2), status: "rejected", message: "blocked: not on allowlist" },
      { relay: n(R3), status: "timeout", message: "timed out" },
    ]);
  });

  it("is not ok — and is not cached or shown to observers — when no relay took it", async () => {
    const net = new FakeNetwork();
    net.refusing.set(n(R1), "no").set(n(R2), "no");
    const { store } = storeOn(net);
    const got = collect(store, [{ kinds: [1] }], { localOnly: true });
    await flush();
    const result = await store.publishEvent(sk("a", "p".repeat(64), 1));
    expect(result).toMatchObject({ ok: false, accepted: 0, total: 2 });
    expect(got.events).toEqual([]);
    expect(await store.seenOn(sk("a", "p".repeat(64), 1).id)).toEqual([]);
  });

  it("hands a successful publish to live observers straight away", async () => {
    const { store } = storeOn(new FakeNetwork());
    const got = collect(store, [{ kinds: [1] }], { localOnly: true });
    await flush();
    const event = sk("a", "p".repeat(64), 1);
    await store.publishEvent(event);
    expect(got.events.map((e) => e.id)).toEqual([event.id]);
  });

  it("adds per-call relays to the defaults, and refuses to publish after close()", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net, [R1]);
    const result = await store.publishEvent(sk("a", "p".repeat(64), 1), { relays: [R3] });
    expect(result.relayResults.map((r) => r.relay)).toEqual([n(R1), n(R3)]);
    store.close();
    await expect(store.publishEvent(sk("b", "p".repeat(64), 1))).rejects.toThrow("closed");
  });

  it("stringifies a non-Error rejection", async () => {
    const pool: RelayPoolLike = {
      subscribeMany: () => ({ close() {} }),
      publish: (relays) => relays.map(() => Promise.reject("plain string")),
      close() {},
    };
    const store = createRelayPoolStore({ relays: [R1], pool });
    const result = await store.publishEvent(sk("a", "p".repeat(64), 1));
    expect(result.relayResults[0]).toEqual({ relay: n(R1), status: "rejected", message: "plain string" });
    store.close();
  });
});

describe("seenOn and the cache", () => {
  it("turns on pool tracking, and merges what relays sent with what accepted our publish", async () => {
    const net = new FakeNetwork();
    const seen = sk("a", "p".repeat(64), 1);
    net.seed(R1, seen).seed(R2, seen);
    const { store, pool } = storeOn(net);
    expect(pool.trackRelays).toBe(true);
    collect(store, [{ kinds: [1] }]);
    await flush();
    expect((await store.seenOn(seen.id)).sort()).toEqual([n(R1), n(R2)].sort());

    const own = sk("b", "p".repeat(64), 1);
    await store.publishEvent(own);
    expect((await store.seenOn(own.id)).sort()).toEqual([n(R1), n(R2)].sort());
    expect(await store.seenOn("f".repeat(64))).toEqual([]);
  });

  it("works with a pool that has no seenOn map", async () => {
    const pool: RelayPoolLike = { subscribeMany: () => ({ close() {} }), publish: (r) => r.map(() => Promise.resolve("")), close() {} };
    const store = createRelayPoolStore({ relays: [R1], pool });
    expect(await store.seenOn("a".repeat(64))).toEqual([]);
    store.close();
  });

  it("keeps at most maxCachedEvents, dropping the oldest", async () => {
    const { store } = storeOn(new FakeNetwork(), [R1], { maxCachedEvents: 2 });
    for (const id of ["a", "b", "c"]) await store.publishEvent(sk(id, "p".repeat(64), 1));
    const got = collect(store, [{ kinds: [1] }], { localOnly: true });
    await flush();
    expect(got.events.map((e) => e.id[0]).sort()).toEqual(["b", "c"]);
  });
});

describe("lifecycle and construction", () => {
  it("close() closes the relays it touched on the pool, and is idempotent", async () => {
    const net = new FakeNetwork();
    const { store } = storeOn(net);
    collect(store, [{ kinds: [1] }]);
    await store.publishEvent(sk("a", "p".repeat(64), 1), { relays: [R3] });
    store.close();
    store.close();
    expect(net.closed).toHaveLength(1);
    expect([...net.closed[0]!].sort()).toEqual([n(R1), n(R2), n(R3)].sort());
  });

  it("close() survives a pool that throws", () => {
    const pool: RelayPoolLike = { subscribeMany: () => ({ close() {} }), publish: () => [], close() { throw new Error("boom"); } };
    expect(() => createRelayPoolStore({ relays: [R1], pool }).close()).not.toThrow();
  });

  it("registers a WebSocket implementation when given one (Node 20), and builds a real pool by default", () => {
    const ws = class FakeWebSocket {};
    const store = createRelayPoolStore({ relays: [R1], webSocket: ws });
    expect(useWebSocketImplementation).toHaveBeenCalledWith(ws);
    store.close();
    const plain = createRelayPoolStore({ relays: [R1] });
    expect(plain.relays).toEqual([n(R1)]);
    plain.close();
  });
});

describe("the SDK runs on it end to end — no local-relay anywhere", () => {
  const transport: BlossomTransport = {
    async upload() {},
    async download() { throw new Error("unused"); },
  };

  /** One relay already holds somebody else's note, so a "new" identity can be told apart from a dead network. */
  function seededNetwork(): FakeNetwork {
    return new FakeNetwork().seed(R1, sk("e", "a".repeat(64), 1)).seed(R2, sk("f", "b".repeat(64), 1));
  }

  it("won't mint on a silent relay, mints once every configured relay has answered, then reads the key back", async () => {
    const identity = makeIdentity(21);
    const dead = seededNetwork();
    dead.silent.add(n(R2));
    const refused = await mintDriveKey({ store: storeOn(dead).store, signer: identity, settleMs: 5, timeoutMs: 120, proofTimeoutMs: 80 }).catch((e) => e);
    expect(refused).toBeInstanceOf(DriveKeyMintRefusedError);
    expect(refused.status.kind).toBe("unresolved");

    const net = seededNetwork();
    const ctx = { store: storeOn(net).store, signer: identity, settleMs: 5, timeoutMs: 120, proofTimeoutMs: 80 };
    expect((await resolveDriveKeyStatus(ctx)).kind).toBe("empty-confirmed"); // configuredRelays came from store.relays
    const minted = await mintDriveKey(ctx);
    const again = await resolveDriveKeyStatus({ ...ctx, store: storeOn(net).store });
    expect(again.kind).toBe("ready");
    if (again.kind === "ready") expect(again.keyring.active.secretKeyHex).toBe(minted.keyring.active.secretKeyHex);
  });

  it("an explicit configuredRelays overrides store.relays: a relay the store never queries can't be proven, so it stays unresolved", async () => {
    const identity = makeIdentity(23);
    const net = seededNetwork();
    const status = await resolveDriveKeyStatus({
      store: storeOn(net).store, signer: identity, configuredRelays: [R1, R2, R3], settleMs: 5, timeoutMs: 120, proofTimeoutMs: 80,
    });
    expect(status).toMatchObject({ kind: "unresolved", reason: expect.stringContaining("Not every configured relay") });
  });

  it("uploads, lists, renames, shares, resolves from a different store, and revokes", async () => {
    const identity = makeIdentity(22);
    const net = seededNetwork();
    const keyring: DriveKeyring = { active: driveKeyEntry("06".repeat(32)), previous: [] };
    const ctx = { store: storeOn(net).store, keyring, quietMs: 10, timeoutMs: 200 };

    const uploaded = await uploadFile(new Uint8Array([1, 2, 3, 4]), {
      name: "hello.txt", type: "text/plain", parent: "", servers: ["https://blossom.example"], d: "file0001",
    }, { store: ctx.store, keyring, signer: identity, transport });
    expect(uploaded.upload.landed).toEqual(["https://blossom.example"]);

    let files: FileEntry[] = [];
    const handle = fetchFiles({ store: storeOn(net).store, keyring, onFiles: (f) => { files = f; } });
    await vi.waitFor(() => expect(files.map((f) => f.name)).toEqual(["hello.txt"]));
    await renameFile(files[0]!, "renamed.txt", { store: ctx.store, keyring });
    await vi.waitFor(() => expect(files[0]!.name).toBe("renamed.txt"));
    handle.stop();

    const shared = await createFileShare(files[0]!, ctx);
    expect(shared.infoWritten).toBe(true);
    // The recipient has a different store and no identity: only the link.
    const recipient = storeOn(net).store;
    const resolved = await resolveShare(shared.url, { store: recipient, quietMs: 10, timeoutMs: 200 });
    expect(resolved.kind === "file" && resolved.file.name).toBe("renamed.txt");

    const [entry] = await listShares(ctx);
    await revokeShare(entry!, ctx);
    const after = await resolveShare(shared.url, { store: storeOn(net).store, quietMs: 10, timeoutMs: 200 });
    expect(after.kind).toBe("revoked");
  });
});
