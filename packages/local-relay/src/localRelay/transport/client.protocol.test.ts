import { createChannelPair } from "./channel";
import { LocalRelayClient, LocalRelayClientOptions } from "./LocalRelayClient";
import { WorkerHost, WorkerHostHooks } from "./WorkerHost";
import { EventDB } from "../core/EventDB";
import { makeEvent } from "../testkit";
import type { EventTemplate } from "nostr-tools";

const NOW = 1_000_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

function wire(opts?: LocalRelayClientOptions, hooks?: WorkerHostHooks) {
  const { client: clientCh, worker: workerCh } = createChannelPair();
  const db = new EventDB(() => NOW);
  const host = new WorkerHost(workerCh, db, hooks);
  const client = new LocalRelayClient(clientCh, opts);
  return { db, host, client };
}

describe("LocalRelayClient ↔ WorkerHost protocol", () => {
  it("observe replays cached matches, EOSEs, then streams live events", async () => {
    const { db, client } = wire();
    db.add(makeEvent({ id: "old".padEnd(64, "0") }));
    const got: string[] = [];
    let eosed = false;
    client.observe([{ kinds: [1] }], {
      onEvent: (e) => got.push(e.id),
      onEose: () => (eosed = true),
    }, { localOnly: true });
    await tick();
    expect(got).toEqual(["old".padEnd(64, "0")]);
    expect(eosed).toBe(true);

    // publish stores + fans out locally regardless of upstream result.
    client.publish(makeEvent({ id: "live".padEnd(64, "0") }));
    await tick();
    expect(got).toContain("live".padEnd(64, "0"));
  });

  it("publish stores the event locally and resolves the upstream outcome", async () => {
    let host: WorkerHost;
    const hooks: WorkerHostHooks = {
      // Stand in for RelayService: report one accepting relay.
      onPublish: (pubId) =>
        host.postPublishResult(pubId, [{ relay: "wss://r", status: "accepted", latencyMs: 0 }]),
    };
    const built = wire(undefined, hooks);
    host = built.host;
    const { db, client } = built;

    const results = await client.publish(makeEvent({ id: "c".repeat(64) }));
    expect(db.getById("c".repeat(64))).toBeDefined(); // stored locally
    expect(results).toEqual([{ relay: "wss://r", status: "accepted", latencyMs: 0 }]);
  });

  it("routes a NIP-42 sign request to the main-thread signer and back", async () => {
    const signed = makeEvent({ id: "auth".padEnd(64, "0"), kind: 22242 });
    const { host } = wire({
      onSignRequest: async (_t: EventTemplate) => signed,
    });
    const template: EventTemplate = { kind: 22242, created_at: NOW, tags: [], content: "" };
    const result = await host.signerPort.sign(template);
    expect(result).toEqual(signed);
  });

  it("resolves sign request with null when the signer refuses", async () => {
    const { host } = wire({ onSignRequest: async () => null });
    const result = await host.signerPort.sign({ kind: 22242, created_at: NOW, tags: [], content: "" });
    expect(result).toBeNull();
  });

  it("ingest adds events to the store (no OK, no upstream); an empty batch is a no-op", async () => {
    const seen: string[] = [];
    const hooks: WorkerHostHooks = { onPublish: () => seen.push("publish") };
    const { db, client } = wire(undefined, hooks);
    client.ingest([makeEvent({ id: "i".repeat(64) })]);
    client.ingest([]); // guarded — sends nothing
    await tick();
    expect(db.getById("i".repeat(64))).toBeDefined();
    expect(seen).toEqual([]); // ingest never publishes upstream
  });

  it("routes setAccount / setUserRelays / pause / resume to the host hooks", async () => {
    const calls: string[] = [];
    let account: string | null = "unset";
    const hooks: WorkerHostHooks = {
      onSetAccount: (pk) => {
        account = pk;
        calls.push("account");
      },
      onSetUserRelays: () => calls.push("relays"),
      onPause: () => calls.push("pause"),
      onResume: () => calls.push("resume"),
    };
    const { client } = wire(undefined, hooks);
    client.setActiveAccount("alice");
    client.setUserRelays(["wss://r"]);
    client.pause();
    client.resume();
    await tick();
    expect(account).toBe("alice");
    expect(calls).toEqual(["account", "relays", "pause", "resume"]);
  });
});

describe("LocalRelayClient frame routing", () => {
  it("ends a subscription on a CLOSED frame and stops delivering to it", async () => {
    // Drive the worker side of the channel by hand to emit raw NIP-01 frames.
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const client = new LocalRelayClient(clientCh);

    const got: string[] = [];
    let eosed = 0;
    const handle = client.observe([{ kinds: [1] }], {
      onEvent: (e) => got.push(e.id),
      onEose: () => eosed++,
    });
    await tick();

    workerCh.post({ kind: "nostr", msg: ["EVENT", handle.id, makeEvent({ id: "a".repeat(64) })] });
    workerCh.post({ kind: "nostr", msg: ["CLOSED", handle.id, "auth-required"] });
    await tick();
    expect(got).toEqual(["a".repeat(64)]);
    expect(eosed).toBe(1); // CLOSED resolves the sub like an EOSE

    // The sub is forgotten — a late EVENT for it is dropped.
    workerCh.post({ kind: "nostr", msg: ["EVENT", handle.id, makeEvent({ id: "b".repeat(64) })] });
    await tick();
    expect(got).toEqual(["a".repeat(64)]);
  });

  it("a second unobserve is a no-op; a sign request with no handler refuses", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const sent: any[] = [];
    workerCh.onMessage((m) => sent.push(m));
    const client = new LocalRelayClient(clientCh); // no onSignRequest configured

    const handle = client.observe([{ kinds: [1] }], { onEvent: () => {} });
    handle.unobserve();
    handle.unobserve(); // already removed → no second unobserve frame
    workerCh.post({
      kind: "signRequest",
      reqId: "r1",
      template: { kind: 22242, created_at: 0, tags: [], content: "" },
    });
    await tick();

    expect(sent.filter((m) => m.kind === "unobserve")).toHaveLength(1);
    expect(sent.find((m) => m.kind === "signResult")).toEqual({ kind: "signResult", reqId: "r1", event: null });
  });

  it("ignores publishResult / relayHealth frames for unknown ids", async () => {
    const { client: clientCh, worker: workerCh } = createChannelPair();
    const client = new LocalRelayClient(clientCh);
    void client;
    // No pending publish/health/diagnostics with these ids — silently ignored.
    workerCh.post({ kind: "publishResult", pubId: "ghost", results: [] });
    workerCh.post({ kind: "relayHealth", reqId: "ghost", relays: [] });
    workerCh.post({
      kind: "diagnostics",
      reqId: "ghost",
      diagnostics: {
        paused: false,
        interests: [],
        upstream: [],
        relays: [],
        cache: { totalEvents: 0, eventsByKind: {}, totalAuthors: 0 },
        enrichment: { queuedIds: 0, queuedAuthors: 0, pending: false },
      },
    });
    workerCh.post({ kind: "ready" });
    await tick();
    // Reaching here without throwing is the assertion.
    expect(true).toBe(true);
  });
});
