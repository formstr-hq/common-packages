import type { Event } from "nostr-tools";
import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
// @ts-expect-error plain ESM script, deliberately outside src/ and its types
import { makeThrowawayIdentity, runSmoke } from "../scripts/smoke-flow.mjs";
import { FakeNetwork, n } from "./fake-network.js";

// Runs the live smoke flow against in-memory relays and an in-memory Blossom server. This is how the flow
// itself is verified — its checks, its soft/hard failure handling, its cleanup — before scripts/smoke.mjs is
// ever pointed at real infrastructure.

const R1 = "wss://relay.one";
const R2 = "wss://relay.two";
const BLOSSOM = ["https://blossom.one", "https://blossom.two"];

interface MemoryBlossomOptions {
  ignoreRange?: boolean;
  refuseUploads?: boolean;
  ignoreDelete?: boolean;
}

function memoryBlossom(options: MemoryBlossomOptions = {}) {
  const blobs = new Map<string, Uint8Array>();
  const key = (server: string, hash: string) => `${server}/${hash}`;
  const hashOf = async (bytes: Uint8Array) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) => b.toString(16).padStart(2, "0")).join("");
  const transport: sdk.BlossomTransport = {
    async canAccept() { return { ok: true }; },
    async upload({ server, bytes }) {
      if (options.refuseUploads) throw new sdk.BlossomHttpError("no thanks", 403);
      blobs.set(key(server, await hashOf(bytes)), new Uint8Array(bytes));
    },
    async download({ server, hash }) {
      const bytes = blobs.get(key(server, hash));
      if (!bytes) throw new sdk.BlossomHttpError("not found", 404);
      return new Uint8Array(bytes);
    },
    async downloadStream({ server, hash }) {
      const bytes = blobs.get(key(server, hash));
      if (!bytes) throw new sdk.BlossomHttpError("not found", 404);
      let offset = 0;
      return { read: async () => (offset >= bytes.length ? { done: true } : { done: false, value: bytes.slice(offset, (offset += 1000)) }) };
    },
    async downloadRange({ server, hash, start, end }) {
      const bytes = blobs.get(key(server, hash));
      if (!bytes) throw new sdk.BlossomHttpError("not found", 404);
      return options.ignoreRange ? { bytes: new Uint8Array(bytes), satisfied: false } : { bytes: bytes.slice(start, end + 1), satisfied: true };
    },
    async exists({ server, hash }) { return blobs.has(key(server, hash)); },
    async delete({ server, hash }) { if (!options.ignoreDelete) blobs.delete(key(server, hash)); },
  };
  return { transport, blobs };
}

function network(): FakeNetwork {
  const note = (id: string, pubkey: string): Event => ({ id: id.repeat(64).slice(0, 64), pubkey, kind: 1, created_at: 1, tags: [], content: "hi", sig: "0".repeat(128) });
  return new FakeNetwork().seed(R1, note("a", "a".repeat(64))).seed(R2, note("b", "b".repeat(64)));
}

const run = (net: FakeNetwork, transport: sdk.BlossomTransport, blossom = BLOSSOM) =>
  runSmoke({
    sdk,
    makeStore: () => sdk.createRelayPoolStore({ relays: [R1, R2], pool: net.pool(), eoseTimeoutMs: 30, publishTimeoutMs: 30 }),
    transport,
    blossom,
    waitMs: 1500,
    keyTimeoutMs: 250,
    pollMs: 15,
    settleMs: 25,
  }) as Promise<{ ok: boolean; results: Array<{ name: string; status: string; note: string }>; identity: string }>;

const status = (results: Array<{ name: string; status: string }>, fragment: string) => results.find((r) => r.name.includes(fragment))?.status;

describe("the smoke flow", () => {
  it("passes end to end on healthy relays and servers, and leaves nothing behind", async () => {
    const blossom = memoryBlossom();
    const { ok, results } = await run(network(), blossom.transport);
    expect(results.filter((r) => r.status === "FAIL")).toEqual([]);
    expect(ok).toBe(true);
    for (const fragment of ["drive key", "preflight", "upload", "list from relays", "buffered", "streamed", "byte range", "rename", "share", "revoke", "delete", "no longer listed"]) {
      expect(status(results, fragment), fragment).toBe("PASS");
    }
    expect(blossom.blobs.size).toBe(0); // the blob was removed from every server
  });

  it("mints only because absence was proven, and reads the key back from a fresh store", async () => {
    const { results } = await run(network(), memoryBlossom().transport);
    expect(results.find((r) => r.name.startsWith("drive key"))!.note).toContain("minted");
  });

  it("does not mint when a relay is silent: warns, carries on with a local key, and still passes", async () => {
    const net = network();
    net.silent.add(n(R2));
    const { ok, results } = await run(net, memoryBlossom().transport);
    const drive = results.find((r) => r.name.startsWith("drive key"))!;
    expect(drive.status).toBe("WARN");
    expect(drive.note).toContain("refused to mint");
    expect(net.relay(n(R1)).size).toBeGreaterThan(1); // the rest of the flow did publish
    expect(ok).toBe(true);
  }, 30_000);

  it("a server that ignores Range is a warning, not a failure, and was never decoded", async () => {
    const { ok, results } = await run(network(), memoryBlossom({ ignoreRange: true }).transport);
    const range = results.find((r) => r.name.includes("byte range"))!;
    expect(range.status).toBe("WARN");
    expect(range.note).toContain("ignored Range");
    expect(ok).toBe(true);
  });

  it("a server that does not honor DELETE is reported, not hidden", async () => {
    const { results } = await run(network(), memoryBlossom({ ignoreDelete: true }).transport);
    const del = results.find((r) => r.name.startsWith("delete"))!;
    expect(del.status).toBe("WARN");
    expect(del.note).toContain("do not honor DELETE");
  }, 30_000);

  it("fails — and says so — when no server will take the upload", async () => {
    const { ok, results } = await run(network(), memoryBlossom({ refuseUploads: true }).transport);
    expect(ok).toBe(false);
    expect(status(results, "upload")).toBe("FAIL");
    expect(results.find((r) => r.name.includes("upload"))!.note).toContain("Unable to upload to any Blossom server");
    // Nothing was uploaded, so there is nothing to clean up and no later step ran.
    expect(results.some((r) => r.name.startsWith("delete"))).toBe(false);
  });

  it("uses a different throwaway identity every run", () => {
    const a = makeThrowawayIdentity();
    const b = makeThrowawayIdentity();
    expect(a.pubkey).not.toBe(b.pubkey);
    expect(a.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });
});
