import * as realSdk from "@formstr/drive-sdk";
import type { BlossomTransport, FileEventStore } from "@formstr/drive-sdk";

/**
 * The point of the demo: show exactly what the SDK is asked to do and what goes over the wire. All of the
 * SDK's I/O goes through two seams — `FileEventStore` (relays) and `BlossomTransport` (file servers) — so
 * decorating those two, plus wrapping the SDK's own exports, is enough. Nothing inside the SDK is touched.
 */
export type Layer = "sdk" | "relay" | "blossom";

export interface TraceEntry {
  seq: number;
  at: number;
  layer: Layer;
  /** Function or operation name, e.g. `uploadFile` or `EVENT kind 34578`. */
  name: string;
  /** Arguments, summarised: bytes become `Uint8Array(n)`, secrets are redacted. */
  args: string;
  /** Result summary, filled in when the call settles. */
  result?: string;
  ms?: number;
  error?: string;
  pending: boolean;
}

const SECRET_KEYS = new Set(["secretKeyHex", "secretHex", "encryptionKey", "authorization"]);

/** JSON for humans: no giant byte arrays, no secrets, no live objects. */
export function summarise(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 90 ? `${value.slice(0, 90)}… (${value.length} chars)` : value;
  if (typeof value === "function") return "[function]";
  if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
  if (value instanceof Blob) return `${value instanceof File ? "File" : "Blob"}(${value.size} bytes)`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (Array.isArray(value)) return depth > 3 ? `[${value.length} items]` : value.slice(0, 12).map((v) => summarise(v, depth + 1));
  if (typeof value === "object") {
    if (depth > 3) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(key)) out[key] = "[redacted]";
      else if (key === "signer") out[key] = "[signer]";
      else if (key === "store") out[key] = "[store]";
      else if (key === "transport") out[key] = "[transport]";
      else out[key] = summarise(inner, depth + 1);
    }
    return out;
  }
  return String(value);
}
const show = (value: unknown) => JSON.stringify(summarise(value), null, 1);

export class Trace {
  private entries: TraceEntry[] = [];
  private seq = 0;
  private listeners = new Set<(entries: TraceEntry[]) => void>();
  static readonly MAX = 500;

  subscribe(cb: (entries: TraceEntry[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.entries);
    return () => this.listeners.delete(cb);
  }
  clear(): void {
    this.entries = [];
    this.emit();
  }
  private emit() {
    for (const cb of this.listeners) cb(this.entries);
  }

  /** Records a call; returns a function that closes it. Newest first, like kanban-tester's log. */
  begin(layer: Layer, name: string, args: unknown): (outcome: { result?: unknown; error?: unknown }) => void {
    const entry: TraceEntry = { seq: ++this.seq, at: Date.now(), layer, name, args: show(args), pending: true };
    this.entries = [entry, ...this.entries].slice(0, Trace.MAX);
    this.emit();
    return ({ result, error }) => {
      entry.pending = false;
      entry.ms = Date.now() - entry.at;
      if (error !== undefined) entry.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      else if (result !== undefined) entry.result = show(result);
      this.entries = [...this.entries];
      this.emit();
    };
  }
}

/** Every function export of the SDK, wrapped so each call shows up in the trace. */
export function tracedSdk(trace: Trace): typeof realSdk {
  const wrapped: Record<string, unknown> = {};
  for (const [name, member] of Object.entries(realSdk)) {
    // Capitalised exports are error classes; the SDK constructs them, the app never calls them.
    if (typeof member !== "function" || /^[A-Z]/.test(name)) {
      wrapped[name] = member;
      continue;
    }
    wrapped[name] = (...args: unknown[]) => {
      const done = trace.begin("sdk", name, args.length === 1 ? args[0] : args);
      try {
        const result = (member as (...a: unknown[]) => unknown)(...args);
        if (result instanceof Promise) {
          return result.then(
            (value) => (done({ result: value ?? "ok" }), value),
            (error) => (done({ error }), Promise.reject(error)),
          );
        }
        if (result && typeof result === "object" && Symbol.asyncIterator in result) {
          done({ result: "(async stream, consumed by the caller)" });
          return result;
        }
        done({ result: result ?? "ok" });
        return result;
      } catch (error) {
        done({ error });
        throw error;
      }
    };
  }
  return wrapped as typeof realSdk;
}

/** Decorates a FileEventStore so every relay query and publish is visible. */
export function tracedStore(inner: FileEventStore, trace: Trace): FileEventStore {
  const store: FileEventStore = {
    observe(filters, handlers, options) {
      const done = trace.begin("relay", "REQ", { filters, ...options });
      let count = 0;
      return inner.observe(
        filters,
        {
          onEvent: (event) => {
            count += 1;
            handlers.onEvent(event);
          },
          onEose: () => {
            done({ result: `EOSE after ${count} event(s)` });
            handlers.onEose?.();
          },
        },
        options,
      );
    },
    async publishEvent(event, options) {
      const done = trace.begin("relay", `EVENT kind ${event.kind}`, {
        id: event.id.slice(0, 12),
        pubkey: event.pubkey.slice(0, 12),
        tags: event.tags.map((t) => t[0]).join(","),
        "content (ciphertext)": event.content.slice(0, 60) + (event.content.length > 60 ? "…" : ""),
        ...options,
      });
      try {
        const result = await inner.publishEvent(event, options);
        done({ result });
        return result;
      } catch (error) {
        done({ error });
        throw error;
      }
    },
  };
  if (inner.seenOn) store.seenOn = (id) => inner.seenOn!(id);
  Object.defineProperty(store, "relays", { get: () => inner.relays });
  return store;
}

const TRANSPORT_LABELS: Record<string, string> = {
  upload: "PUT /upload",
  download: "GET /<hash>",
  canAccept: "HEAD /upload",
  downloadStream: "GET /<hash> (stream)",
  downloadRange: "GET /<hash> with Range",
  exists: "HEAD /<hash>",
  delete: "DELETE /<hash>",
};

/** Decorates a BlossomTransport so every file-server request is visible. */
export function tracedTransport(inner: BlossomTransport, trace: Trace): BlossomTransport {
  const out: Record<string, unknown> = {};
  for (const method of Object.keys(TRANSPORT_LABELS)) {
    const fn = (inner as unknown as Record<string, unknown>)[method];
    if (typeof fn !== "function") continue;
    out[method] = async (input: Record<string, unknown>) => {
      const { signal: _signal, onBytes: _onBytes, ...rest } = input;
      const done = trace.begin("blossom", TRANSPORT_LABELS[method], rest);
      try {
        const result = await (fn as (i: unknown) => Promise<unknown>).call(inner, input);
        done({ result: result === undefined ? "ok" : result });
        return result;
      } catch (error) {
        done({ error });
        throw error;
      }
    };
  }
  return out as unknown as BlossomTransport;
}
