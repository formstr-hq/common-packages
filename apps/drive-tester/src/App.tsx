import { generateSecretKey, getPublicKey, finalizeEvent, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as realSdk from "@formstr/drive-sdk";
import type { DriveKeyStatus, DriveKeyring, FileEntry, IdentitySigner, ResolvedShare, SharedByMeEntry } from "@formstr/drive-sdk";
import { Inspector } from "./Inspector";
import { Trace, tracedSdk, tracedStore, tracedTransport } from "./trace";

const DEFAULT_RELAYS = "wss://relay.formstr.app\nwss://relay.damus.io\nwss://nos.lol";
const DEFAULT_BLOSSOM = "https://nostr.download";

const lines = (text: string) => text.split(/[\s,]+/).filter(Boolean);

/** A throwaway identity. Kept in sessionStorage so a reload keeps your files; "New identity" discards it. */
function loadIdentity(fresh = false): IdentitySigner & { secretHex: string } {
  let secretHex: string | null = null;
  try {
    if (!fresh) secretHex = sessionStorage.getItem("drive-tester:secret");
  } catch {
    /* storage unavailable: fall through to a new key */
  }
  if (!secretHex) secretHex = bytesToHex(generateSecretKey());
  try {
    sessionStorage.setItem("drive-tester:secret", secretHex);
  } catch {
    /* ignore */
  }
  const secret = hexToBytes(secretHex);
  const pubkey = getPublicKey(secret);
  return {
    secretHex,
    getPublicKey: async () => pubkey,
    signEvent: async (template) => finalizeEvent(template, secret),
    nip44Encrypt: async (peer, plaintext) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(secret, peer)),
    nip44Decrypt: async (peer, ciphertext) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(secret, peer)),
  } as IdentitySigner & { secretHex: string };
}

interface Check {
  kind: "relay" | "file server";
  url: string;
  ok: boolean;
  ms: number;
  note: string;
}

const PROBE_TIMEOUT_MS = 6000;

/** Opens a websocket to the relay and closes it again. Proves the relay is reachable from this browser. */
function probeRelay(url: string, trace: Trace): Promise<Check> {
  const done = trace.begin("relay", "WebSocket connect (check)", { url });
  const started = Date.now();
  return new Promise((resolve) => {
    let socket: WebSocket | undefined;
    const finish = (ok: boolean, note: string) => {
      clearTimeout(timer);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      if (ok) done({ result: "connected" });
      else done({ error: note });
      resolve({ kind: "relay", url, ok, ms: Date.now() - started, note });
    };
    const timer = setTimeout(() => finish(false, `no answer after ${PROBE_TIMEOUT_MS / 1000} s`), PROBE_TIMEOUT_MS);
    try {
      socket = new WebSocket(url);
      socket.onopen = () => finish(true, "connected");
      socket.onerror = () => finish(false, "connection failed");
    } catch (error) {
      finish(false, message(error));
    }
  });
}

/** Any HTTP answer at all means the server is reachable. A network error usually means down, offline or blocked by CORS. */
async function probeServer(url: string, trace: Trace): Promise<Check> {
  const target = `${url.replace(/\/+$/, "")}/upload`;
  const done = trace.begin("blossom", "HEAD /upload (check)", { server: url });
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, { method: "HEAD", signal: controller.signal });
    done({ result: `HTTP ${response.status}` });
    return { kind: "file server", url, ok: true, ms: Date.now() - started, note: `answered (HTTP ${response.status})` };
  } catch {
    const note = controller.signal.aborted ? `no answer after ${PROBE_TIMEOUT_MS / 1000} s` : "unreachable, or blocked by the browser (CORS)";
    done({ error: note });
    return { kind: "file server", url, ok: false, ms: Date.now() - started, note };
  } finally {
    clearTimeout(timer);
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
const message = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));

export function App() {
  const trace = useMemo(() => new Trace(), []);
  const sdk = useMemo(() => tracedSdk(trace), [trace]);
  const [identity, setIdentity] = useState(() => loadIdentity());
  const [pubkey, setPubkey] = useState("");
  const [relayText, setRelayText] = useState<string>(DEFAULT_RELAYS);
  const [blossomText, setBlossomText] = useState<string>(DEFAULT_BLOSSOM);
  const [connected, setConnected] = useState<{ store: realSdk.RelayPoolStore; traced: realSdk.FileEventStore; transport: realSdk.BlossomTransport; blossom: string[] } | null>(null);
  const [keyStatus, setKeyStatus] = useState<DriveKeyStatus | null>(null);
  const [keyring, setKeyring] = useState<DriveKeyring | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [shares, setShares] = useState<SharedByMeEntry[]>([]);
  const [shareLink, setShareLink] = useState("");
  const [resolved, setResolved] = useState<ResolvedShare | null>(null);
  const [resolveInput, setResolveInput] = useState(() => (location.hash.startsWith("#shared=") ? location.href : ""));
  const [status, setStatus] = useState("");
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState("");
  const handle = useRef<{ stop(): void } | null>(null);

  useEffect(() => {
    identity.getPublicKey().then(setPubkey);
  }, [identity]);

  const run = useCallback(async (what: string, fn: () => Promise<string | void>) => {
    setBusy(true);
    setStatus(`${what}…`);
    try {
      setStatus((await fn()) || `${what}: done`);
    } catch (error) {
      setStatus(`${what} failed — ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(() => {
    handle.current?.stop();
    connected?.store.close();
    const store = realSdk.createRelayPoolStore({ relays: lines(relayText) });
    setConnected({
      store,
      traced: tracedStore(store, trace),
      transport: tracedTransport(realSdk.createFetchBlossomTransport(), trace),
      blossom: lines(blossomText),
    });
    setKeyStatus(null);
    setKeyring(null);
    setFiles([]);
    setShares([]);
    // Creating the store opens no connection by itself, so test every server now and say what happened.
    const relays = lines(relayText);
    const servers = lines(blossomText);
    setChecks(null);
    setChecking(true);
    setStatus(`Checking ${relays.length} relay(s) and ${servers.length} file server(s)…`);
    void Promise.all([...relays.map((url) => probeRelay(url, trace)), ...servers.map((url) => probeServer(url, trace))]).then((results) => {
      setChecks(results);
      setChecking(false);
      const okRelays = results.filter((r) => r.kind === "relay" && r.ok).length;
      const okServers = results.filter((r) => r.kind === "file server" && r.ok).length;
      const allOk = okRelays === relays.length && okServers === servers.length;
      setStatus(
        `Reached ${okRelays}/${relays.length} relay(s) and ${okServers}/${servers.length} file server(s). ` +
          (allOk ? "Next: resolve the Drive Key." : okRelays === 0 ? "No relay answered, so nothing will work. Check the URLs or your network." : "Some servers did not answer; see the list under Connect."),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relayText, blossomText, trace]);

  useEffect(() => {
    connect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const keyOptions = { timeoutMs: 8000, settleMs: 1500, proofTimeoutMs: 8000 };

  const resolveKey = () =>
    run("Resolve Drive Key", async () => {
      const result = await sdk.resolveDriveKeyStatus({ store: connected!.traced, signer: identity, ...keyOptions });
      setKeyStatus(result);
      if (result.kind === "ready") setKeyring(result.keyring);
      return result.kind === "ready" ? "Drive Key found." : result.kind === "empty-confirmed" ? "No Drive Key exists on any relay (proven). You may mint one." : `Unresolved: ${result.reason}. The SDK will not mint.`;
    });

  const mintKey = () =>
    run("Mint Drive Key", async () => {
      const minted = await sdk.mintDriveKey({ store: connected!.traced, signer: identity, ...keyOptions });
      setKeyring(minted.keyring);
      setKeyStatus({ kind: "ready", keyring: minted.keyring } as DriveKeyStatus);
      return `Minted and published to ${minted.publishResult.accepted}/${minted.publishResult.total} relays.`;
    });

  const refreshFiles = useCallback(() => {
    if (!connected || !keyring) return;
    handle.current?.stop();
    handle.current = sdk.fetchFiles({ store: connected.traced, keyring, onFiles: (list) => setFiles(list), onEose: () => {} });
  }, [connected, keyring, sdk]);

  useEffect(() => {
    refreshFiles();
    return () => handle.current?.stop();
  }, [refreshFiles]);

  const ctx = () => ({ store: connected!.traced, keyring: keyring!, signer: identity, transport: connected!.transport });

  const upload = (file: File) =>
    run(`Upload ${file.name}`, async () => {
      const result = await sdk.uploadFile(new Uint8Array(await file.arrayBuffer()), { name: file.name, type: file.type || "application/octet-stream", parent: "", servers: connected!.blossom }, ctx());
      const { landed, failures } = result.upload;
      return `Uploaded: ${landed.length} server(s) took it${failures.length ? `, ${failures.length} failed` : ""}; metadata on ${result.publishResult.accepted}/${result.publishResult.total} relays.`;
    });

  const saveBlob = (blob: Blob, name: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  const download = (file: FileEntry) =>
    run(`Download ${file.name}`, async () => {
      const blob = await sdk.downloadFile(file, { transport: connected!.transport, signer: identity });
      saveBlob(blob, file.name);
      return `Downloaded and decrypted ${blob.size} bytes.`;
    });

  const stream = (file: FileEntry) =>
    run(`Stream ${file.name}`, async () => {
      let total = 0;
      let parts = 0;
      for await (const part of sdk.downloadFileStream(file, { transport: connected!.transport, signer: identity })) {
        total += part.length;
        parts += 1;
      }
      return `Streamed ${total} decrypted bytes in ${parts} piece(s); nothing was held whole in memory.`;
    });

  const range = (file: FileEntry) =>
    run(`Read bytes 0–31 of ${file.name}`, async () => {
      const end = Math.min(31, file.size - 1);
      const bytes = await sdk.readFileRange(file, 0, end, { transport: connected!.transport, signer: identity });
      setPreview(hex(bytes));
      return `Fetched only the covering segment(s) and decrypted ${bytes.length} bytes. See the hex below.`;
    });

  const rename = (file: FileEntry) => {
    const name = window.prompt("New name", file.name);
    if (name && name !== file.name) void run("Rename", async () => { await sdk.renameFile(file, name, { store: connected!.traced, keyring: keyring! }); });
  };

  const remove = (file: FileEntry) => {
    if (!window.confirm(`Delete ${file.name}? This tombstones it and removes the blob from the servers.`)) return;
    void run(`Delete ${file.name}`, async () => {
      // This sample does not scan the whole drive for other files sharing the blob, so it is honest about that:
      // it only deletes the blob when this list has no other file pointing at the same hash.
      const stillReferenced = new Set(files.filter((f) => f.id !== file.id && f.blobHash).map((f) => f.blobHash!));
      const result = await sdk.deleteFile(file, ctx(), { stillReferenced });
      return `Tombstoned. Blob deleted on ${result.blobs.deleted.length} server(s), failed on ${result.blobs.failed.length}.`;
    });
  };

  const baseUrl = () => `${location.origin}${location.pathname}`;
  const share = (file: FileEntry) =>
    run(`Share ${file.name}`, async () => {
      const result = await sdk.createFileShare(file, { store: connected!.traced, keyring: keyring!, timeoutMs: 8000, quietMs: 1500 });
      const link = result.url.startsWith("#") ? `${baseUrl()}${result.url}` : result.url;
      setShareLink(link);
      return `${result.reused ? "Reused the existing live share." : "Share created."}${result.infoWritten ? "" : " (Link works, but 'Shared by me' bookkeeping failed.)"}`;
    });

  const loadShares = () =>
    run("List shares", async () => {
      const list = await sdk.listShares({ store: connected!.traced, keyring: keyring!, timeoutMs: 8000, quietMs: 1500 });
      setShares(list);
      return `${list.length} share(s) by this drive.`;
    });

  const revoke = (entry: SharedByMeEntry) =>
    run(`Revoke ${entry.name}`, async () => {
      await sdk.revokeShare(entry, { store: connected!.traced, keyring: keyring!, timeoutMs: 8000, quietMs: 1500 });
      setShares((current) => current.map((s) => (s.infoD === entry.infoD ? { ...s, revokedAt: Math.floor(Date.now() / 1000) } : s)));
      return "Revoked: a superseding event now sits at the share's address.";
    });

  const resolve = () =>
    run("Resolve share link", async () => {
      const result = await sdk.resolveShare(resolveInput.trim(), { store: connected!.traced, timeoutMs: 8000, quietMs: 1500 });
      setResolved(result);
      return result.kind === "file" ? `Resolved to ${result.file.name} from the link alone — no login needed.` : "This link has been revoked.";
    });

  const downloadResolved = () => {
    if (resolved?.kind === "file") void download(resolved.file);
  };

  const ready = connected && keyring;

  return (
    <div className="layout">
      <main>
        <h1>Drive SDK Tester</h1>
        <p className="muted">
          A tester for <code>@formstr/drive-sdk</code>. Every SDK call and every relay / file-server request appears in the inspector on the right.
          Throwaway key, discarded when you press “New identity”.
        </p>

        <section>
          <h2>1 · Connect</h2>
          <p className="muted">Real servers: the app writes small encrypted events and files under a throwaway key. Edit the lists to use your own.</p>
          <label>Relays (one per line)<textarea rows={3} value={relayText} onChange={(e) => setRelayText(e.target.value)} /></label>
          <label>Blossom servers<textarea rows={2} value={blossomText} onChange={(e) => setBlossomText(e.target.value)} /></label>
          <div className="row">
            <button disabled={checking} onClick={connect}>{checking ? "Checking…" : "Connect"}</button>
            <button onClick={() => { setIdentity(loadIdentity(true)); connect(); }}>New identity</button>
            <span className="muted mono">you: {pubkey.slice(0, 16)}…</span>
          </div>
          {checks && (
            <ul className="checks">
              {checks.map((c) => (
                <li key={`${c.kind}:${c.url}`} className={c.ok ? "ok" : "bad"}>
                  <strong>{c.ok ? "✓" : "✗"}</strong> {c.kind} <span className="mono">{c.url}</span> <span className="muted">{c.note} · {c.ms} ms</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>2 · Drive Key</h2>
          <p className="muted">One replaceable event holds the encryption key for the whole drive. The SDK refuses to mint a new one unless every relay has answered “nothing here”.</p>
          <div className="row">
            <button disabled={!connected || busy} onClick={resolveKey}>Resolve</button>
            <button disabled={!connected || busy || keyStatus?.kind !== "empty-confirmed"} onClick={mintKey}>Mint (only if empty is proven)</button>
            <strong>{keyStatus ? keyStatus.kind : "not resolved"}</strong>
          </div>
        </section>

        <section>
          <h2>3 · Files</h2>
          <input type="file" disabled={!ready || busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void upload(file); e.target.value = ""; }} />
          <table>
            <thead><tr><th>Name</th><th>Size</th><th /></tr></thead>
            <tbody>
              {files.length === 0 && <tr><td colSpan={3} className="muted">{ready ? "No files yet — upload one." : "Resolve the Drive Key first."}</td></tr>}
              {files.map((file) => (
                <tr key={file.id}>
                  <td>{file.name}{file.legacyChunked && " (legacy chunked)"}</td>
                  <td>{file.size}</td>
                  <td className="actions">
                    <button disabled={busy} onClick={() => download(file)}>Download</button>
                    <button disabled={busy} onClick={() => stream(file)}>Stream</button>
                    <button disabled={busy} onClick={() => range(file)}>Range</button>
                    <button disabled={busy} onClick={() => rename(file)}>Rename</button>
                    <button disabled={busy} onClick={() => share(file)}>Share</button>
                    <button disabled={busy} onClick={() => remove(file)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview && <pre className="mono">{preview}</pre>}
        </section>

        <section>
          <h2>4 · Sharing</h2>
          {shareLink && (
            <p>Share link (open it in a <em>different browser profile</em> to play the recipient):<br /><input className="mono wide" readOnly value={shareLink} onFocus={(e) => e.target.select()} /></p>
          )}
          <div className="row">
            <button disabled={!ready || busy} onClick={loadShares}>List “Shared by me”</button>
          </div>
          {shares.map((s) => (
            <div key={s.infoD} className="row">
              <span>{s.name}</span>
              <span className="muted">{s.revokedAt ? "revoked" : "live"}</span>
              <button disabled={busy || !!s.revokedAt} onClick={() => revoke(s)}>Revoke</button>
            </div>
          ))}
          <h3>Open a share link (no login needed)</h3>
          <div className="row">
            <input className="mono wide" placeholder="paste a share link" value={resolveInput} onChange={(e) => setResolveInput(e.target.value)} />
            <button disabled={!connected || busy || !resolveInput} onClick={resolve}>Resolve</button>
          </div>
          {resolved?.kind === "file" && (
            <p>{resolved.file.name} · {resolved.file.size} bytes <button disabled={busy} onClick={downloadResolved}>Download</button></p>
          )}
          {resolved?.kind === "revoked" && <p><strong>Revoked</strong> {new Date(resolved.at * 1000).toLocaleString()}</p>}
        </section>

        <p className="status" role="status">{status}</p>
      </main>
      <Inspector trace={trace} />
    </div>
  );
}
