// The end-to-end flow behind `pnpm smoke`, kept free of any network setup so it can be run two ways:
// against real relays and a real Blossom server (scripts/smoke.mjs), and against in-memory fakes (the
// vitest suite, test/smoke.test.ts), which is how the flow itself is checked before it is ever pointed at
// shared infrastructure.
//
// It is a smoke test, not a unit test: one brand-new throwaway identity walks the whole product —
// drive key, upload, list, download (buffered, streamed, ranged), rename, share, resolve, revoke, delete —
// and every check that crosses the network re-reads through a FRESH store, so a pass means the relays and
// servers really hold the data, not that a local cache remembers it.
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";

/** A throwaway signer with a key that exists only for this run. */
export function makeThrowawayIdentity() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return {
    pubkey,
    secretHex: bytesToHex(secret),
    getPublicKey: async () => pubkey,
    signEvent: async (template) => finalizeEvent(template, secret),
    nip44Encrypt: async (peer, plaintext) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, peer)),
    nip44Decrypt: async (peer, ciphertext) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, peer)),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `fn` returns something truthy, or throws `what` after `timeoutMs`. */
async function waitFor(what, fn, { timeoutMs, intervalMs }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(intervalMs);
  }
}

function sameBytes(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * @param {object} options
 * @param {typeof import("../src/index.js")} options.sdk        the SDK under test (src in vitest, dist from the CLI)
 * @param {() => object} options.makeStore                       a NEW store each call: fresh connections, fresh cache
 * @param {object} options.transport                              a BlossomTransport
 * @param {string[]} options.blossom                              Blossom server URLs to upload to
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.waitMs]                               how long a cross-network check may take to converge
 * @param {number} [options.pollMs]
 * @param {number} [options.settleMs]                             drive-key / list settle window
 * @param {number} [options.keyTimeoutMs]                         cap on each Drive Key lookup (default 8000). A brand-new identity
 *                                                                always waits this long for "any history?": absence cannot be known sooner.
 */
export async function runSmoke(options) {
  const { sdk, makeStore, transport, blossom, log = () => {} } = options;
  const waitMs = options.waitMs ?? 20_000;
  const pollMs = options.pollMs ?? 500;
  const settleMs = options.settleMs ?? 2_000;
  const keyTimeoutMs = options.keyTimeoutMs ?? 8_000;
  const results = [];
  const state = {};
  const stores = [];
  const fresh = () => { const store = makeStore(); stores.push(store); return store; };
  const identity = makeThrowawayIdentity();

  /** Records one step. A `soft` step downgrades a failure to a warning and the run goes on. */
  async function step(name, fn, { soft = false } = {}) {
    const started = Date.now();
    try {
      const note = (await fn()) ?? "";
      results.push({ name, status: "PASS", ms: Date.now() - started, note });
    } catch (error) {
      const note = error instanceof Error ? error.message : String(error);
      results.push({ name, status: soft ? "WARN" : "FAIL", ms: Date.now() - started, note });
      if (!soft) throw Object.assign(new Error(`${name}: ${note}`), { smokeStep: true });
    } finally {
      const last = results[results.length - 1];
      log(`${last.status.padEnd(4)} ${last.name} (${last.ms} ms)${last.note ? ` — ${last.note}` : ""}`);
    }
  }

  const listFiles = (store) => new Promise((resolve) => {
    let latest = [];
    const handle = sdk.fetchFiles({
      store,
      keyring: state.keyring,
      onFiles: (files) => { latest = files; },
      onEose: () => setTimeout(() => { handle.stop(); resolve(latest); }, settleMs),
    });
    setTimeout(() => { handle.stop(); resolve(latest); }, waitMs);
  });
  const waitForFile = (what, predicate) => waitFor(what, async () => {
    const files = await listFiles(fresh());
    return predicate(files);
  }, { timeoutMs: waitMs, intervalMs: pollMs });
  const downloadCtx = () => ({ transport, signer: identity });

  const original = new Uint8Array(6000).map((_, index) => (index * 31 + 7) % 251);

  try {
    await step("drive key: resolve, and mint only if absence is proven", async () => {
      const store = fresh();
      const status = await sdk.resolveDriveKeyStatus({ store, signer: identity, timeoutMs: keyTimeoutMs, settleMs, proofTimeoutMs: keyTimeoutMs });
      if (status.kind === "ready") {
        state.keyring = status.keyring;
        return "ready (unexpected for a brand-new identity, but usable)";
      }
      if (status.kind === "empty-confirmed") {
        const minted = await sdk.mintDriveKey({ store, signer: identity, timeoutMs: keyTimeoutMs, settleMs, proofTimeoutMs: keyTimeoutMs });
        const again = await waitFor("the minted key to be readable from a fresh store", async () => {
          const next = await sdk.resolveDriveKeyStatus({ store: fresh(), signer: identity, timeoutMs: keyTimeoutMs, settleMs, proofTimeoutMs: keyTimeoutMs });
          return next.kind === "ready" && next.keyring.active.secretKeyHex === minted.keyring.active.secretKeyHex ? next : null;
        }, { timeoutMs: waitMs, intervalMs: pollMs });
        state.keyring = again.keyring;
        return `empty-confirmed → minted, read back from a fresh store (${minted.publishResult.accepted}/${minted.publishResult.total} relays)`;
      }
      // Relays did not all answer, so emptiness is NOT proven and the SDK correctly refuses to mint. Keep going
      // with a local key: the rest of the product does not need the key to be published.
      state.keyring = { active: sdk.driveKeyEntry(bytesToHex(generateSecretKey())), previous: [] };
      throw new Error(`unresolved (${status.reason}) — SDK refused to mint, which is correct; continuing with a local key`);
    }, { soft: true });

    await step("blossom: BUD-06 preflight per server", async () => {
      if (!transport.canAccept) return "transport has no canAccept";
      const notes = [];
      for (const server of blossom) {
        const verdict = await transport.canAccept({ server, size: original.length + 16, sha256: "0".repeat(64), type: "application/octet-stream" });
        notes.push(`${server}: ${verdict.ok ? "ok/inconclusive" : `refused ${verdict.status}`}`);
      }
      return notes.join("; ");
    }, { soft: true });

    await step("upload to blossom + publish metadata", async () => {
      state.uploaded = await sdk.uploadFile(original, {
        name: `smoke-${Date.now()}.bin`, type: "application/octet-stream", parent: "", servers: blossom,
      }, { store: fresh(), keyring: state.keyring, signer: identity, transport });
      const { landed, failures } = state.uploaded.upload;
      state.id = state.uploaded.metadata.d;
      state.hash = state.uploaded.encryptedFile.blobHash;
      return `landed on ${landed.length}/${blossom.length} server(s)${failures.length ? `; failed: ${failures.map((f) => f.server).join(", ")}` : ""}; metadata on ${state.uploaded.publishResult.accepted}/${state.uploaded.publishResult.total} relays`;
    });

    await step("list from relays through a fresh store", async () => {
      state.entry = await waitForFile("the uploaded file to be listed", (files) => files.find((f) => f.id === state.id));
      return `${state.entry.name}, ${state.entry.size} bytes, author is the Drive Key (${state.entry.author === state.keyring.active.publicKey})`;
    });

    await step("download: buffered, and verified against the plaintext", async () => {
      const blob = await sdk.downloadFile(state.entry, downloadCtx());
      if (!sameBytes(new Uint8Array(await blob.arrayBuffer()), original)) throw new Error("downloaded bytes differ from what was uploaded");
      return "bytes match";
    });

    await step("download: streamed segment by segment", async () => {
      const parts = [];
      for await (const part of sdk.downloadFileStream(state.entry, downloadCtx())) parts.push(...part);
      if (!sameBytes(new Uint8Array(parts), original)) throw new Error("streamed bytes differ from what was uploaded");
      return "bytes match";
    });

    await step("download: byte range 1000-1999 (fetches only the covering segments)", async () => {
      try {
        const range = await sdk.readFileRange(state.entry, 1000, 1999, downloadCtx());
        if (!sameBytes(range, original.subarray(1000, 2000))) throw new Error("range bytes differ");
        return "bytes match";
      } catch (error) {
        if (error instanceof sdk.RangeNotSatisfiedError) throw new Error("server ignored Range (200) — SDK refused to decode it; fall back to streaming");
        throw error;
      }
    }, { soft: true });

    await step("rename, visible through a fresh store", async () => {
      await sdk.renameFile(state.entry, "smoke-renamed.bin", { store: fresh(), keyring: state.keyring });
      state.entry = await waitForFile("the rename", (files) => files.find((f) => f.id === state.id && f.name === "smoke-renamed.bin"));
      return "renamed under the same id";
    });

    await step("share: create, then resolve from a fresh store with no identity", async () => {
      state.share = await sdk.createFileShare(state.entry, { store: fresh(), keyring: state.keyring, timeoutMs: waitMs, quietMs: settleMs });
      if (!state.share.infoWritten) throw new Error(`link works but bookkeeping failed: ${String(state.share.infoError)}`);
      const resolved = await waitFor("the share to resolve", async () => {
        try {
          return await sdk.resolveShare(state.share.url, { store: fresh(), timeoutMs: waitMs, quietMs: settleMs });
        } catch {
          return null;
        }
      }, { timeoutMs: waitMs, intervalMs: pollMs });
      if (resolved.kind !== "file" || resolved.file.name !== "smoke-renamed.bin") throw new Error(`resolved to ${JSON.stringify(resolved.kind)}`);
      return "recipient resolved the file from the link alone";
    });

    await step("revoke: the same link now reads as revoked", async () => {
      const entries = await waitFor("the share to appear in 'Shared by me'", async () => {
        const list = await sdk.listShares({ store: fresh(), keyring: state.keyring, timeoutMs: waitMs, quietMs: settleMs });
        return list.length > 0 ? list : null;
      }, { timeoutMs: waitMs, intervalMs: pollMs });
      const mine = entries.find((e) => e.url === state.share.url) ?? entries[0];
      await sdk.revokeShare(mine, { store: fresh(), keyring: state.keyring, timeoutMs: waitMs, quietMs: settleMs });
      await waitFor("the link to read as revoked", async () => {
        try {
          return (await sdk.resolveShare(state.share.url, { store: fresh(), timeoutMs: waitMs, quietMs: settleMs })).kind === "revoked";
        } catch {
          return false;
        }
      }, { timeoutMs: waitMs, intervalMs: pollMs });
      return "resolve → revoked";
    });
  } catch (error) {
    if (!error?.smokeStep) {
      results.push({ name: "(unexpected error)", status: "FAIL", ms: 0, note: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    // Cleanup runs even after a failure, so a failed run still removes what it uploaded. This identity is
    // brand new, so its index is complete by construction: nothing else can reference the blob.
    if (state.entry) {
      await step("delete: tombstone, NIP-09, and remove the blob from every server", async () => {
        const result = await sdk.deleteFile(state.entry, { store: fresh(), keyring: state.keyring, signer: identity, transport }, { stillReferenced: new Set() });
        const gone = [];
        const left = [];
        for (const server of state.entry.servers) {
          if (!transport.exists) break;
          let present;
          try {
            await waitFor(`${server} to drop the blob`, async () => !(await transport.exists({ server, hash: state.hash })), { timeoutMs: 5_000, intervalMs: pollMs });
            present = false;
          } catch {
            present = true; // still there, or the server could not say
          }
          (present ? left : gone).push(server);
        }
        if (left.length > 0) throw new Error(`blob still on: ${left.join(", ")} (deleted on ${result.blobs.deleted.length}, failed on ${result.blobs.failed.length}) — some servers do not honor DELETE`);
        return `tombstone published; blob gone from ${gone.length} server(s)`;
      }, { soft: true });
      await step("deleted file no longer listed", async () => {
        await waitFor("the tombstone to hide the file", async () => !(await listFiles(fresh())).some((f) => f.id === state.id), { timeoutMs: waitMs, intervalMs: pollMs });
        return "hidden by its tombstone";
      }, { soft: true });
    }
    for (const store of stores) store.close?.();
  }

  const failed = results.filter((r) => r.status === "FAIL");
  return { ok: failed.length === 0, results, identity: identity.pubkey };
}
