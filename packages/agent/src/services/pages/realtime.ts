import { nostrRuntime, relayManager, signerManager } from "@formstr/core";
import type { Event, Filter } from "nostr-tools";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

import { collabRoom, contentTags, parseRootAddress } from "./sharedDoc";
import { PAGES_KINDS } from "./types";
import { encryptWithViewKey, decryptWithViewKey } from "./viewKey";

/**
 * v2 realtime collaboration over Nostr (see `NIP-multi-writer-documents.md`).
 *
 * Relays are pub/sub for viewKey-encrypted Yjs sync-protocol messages (kind
 * 22457) and awareness updates (kind 24578), tagged `["a", room]` and signed by
 * a per-tab **session key**. The real identity rides inside each encrypted
 * payload as a real-key-signed attestation (kind 34581, never published), so a
 * relay never sees who is editing. Conflict resolution is entirely Yjs's.
 *
 * Yjs and the y-protocols are dynamically imported so importing this module
 * (or the pages service barrel) never pulls them into a host's bundle unless a
 * collab session is actually opened.
 *
 * The shared document is a TipTap ProseMirror document stored in a Yjs
 * `XmlFragment("default")`. This module edits that fragment by Yjs node name
 * only ("paragraph", "heading", …) — it does not depend on tiptap/prosemirror,
 * so the AI-authored blocks render in the Pages editor without the MCP process
 * needing the editor's schema.
 */

// ── base64 (Node + browser) ─────────────────────────────

function toBase64(bytes: Uint8Array): string {
  const g = globalThis as unknown as {
    Buffer?: { from(b: Uint8Array): { toString(enc: string): string } };
    btoa?: (s: string) => string;
  };
  if (g.Buffer) return g.Buffer.from(bytes).toString("base64");
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return g.btoa!(bin);
}

function fromBase64(b64: string): Uint8Array {
  const g = globalThis as unknown as {
    Buffer?: { from(s: string, enc: string): Uint8Array };
    atob?: (s: string) => string;
  };
  if (g.Buffer) return new Uint8Array(g.Buffer.from(b64, "base64"));
  const bin = g.atob!(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Dynamic Yjs environment ─────────────────────────────

interface YEnv {
  Y: typeof import("yjs");
  encoding: typeof import("lib0/encoding");
  decoding: typeof import("lib0/decoding");
  sync: typeof import("y-protocols/sync");
  awareness: typeof import("y-protocols/awareness");
}

let envPromise: Promise<YEnv> | null = null;

function loadYEnv(): Promise<YEnv> {
  if (!envPromise) {
    envPromise = Promise.all([
      import("yjs"),
      import("lib0/encoding"),
      import("lib0/decoding"),
      import("y-protocols/sync"),
      import("y-protocols/awareness"),
    ]).then(([Y, encoding, decoding, sync, awareness]) => ({ Y, encoding, decoding, sync, awareness }));
  }
  return envPromise;
}

// ── Session keys + embedded attestation ─────────────────

/** How long a session key's attestation is valid before a fresh signer prompt. */
const SESSION_TTL_SEC = 12 * 60 * 60;

/**
 * A per-tab collaboration session. `attestation` is a real-key-signed event
 * binding `sessionPubkey` to `realPubkey`; it is embedded in each op/presence
 * payload (never published), so there is no separate event to store.
 */
export interface CollabSessionKeys {
  viewKey: string;
  sessionSecretKey: Uint8Array;
  sessionPubkey: string;
  realPubkey: string | null;
  expiresAt: number;
  attestation: Event | null;
}

const sessionCache = new Map<string, CollabSessionKeys>();

/**
 * Mint (or reuse) this process's collaboration session for a document. When a
 * signer is available, one signer prompt produces the embedded attestation;
 * every subsequent op is signed locally by the session key.
 */
export async function getOrCreateSessionKeys(
  viewKey: string,
  address: string,
): Promise<CollabSessionKeys> {
  const cached = sessionCache.get(address);
  if (cached && cached.expiresAt * 1000 > Date.now()) return cached;

  const sessionSecretKey = generateSecretKey();
  const sessionPubkey = getPublicKey(sessionSecretKey);
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const room = collabRoom(viewKey);

  let realPubkey: string | null = null;
  let attestation: Event | null = null;

  const signer = signerManager.getSignerIfAvailable();
  if (signer) {
    try {
      realPubkey = await signer.getPublicKey();
      attestation = (await signer.signEvent({
        kind: PAGES_KINDS.sessionAttestation,
        tags: [["d", `${room}:${sessionPubkey}`]],
        // Plaintext: the whole payload is embedded inside a viewKey-encrypted op.
        content: JSON.stringify({ realPubkey, expiresAt }),
        created_at: Math.floor(Date.now() / 1000),
      })) as Event;
    } catch {
      // A signer that can't sign the attestation still allows an anonymous
      // (unattributed) session: ops are capability-authorized by the viewKey.
      realPubkey = null;
      attestation = null;
    }
  }

  const session: CollabSessionKeys = {
    viewKey,
    sessionSecretKey,
    sessionPubkey,
    realPubkey,
    expiresAt,
    attestation,
  };
  sessionCache.set(address, session);
  return session;
}

/** session pubkey → attested real pubkey, fed by embedded attestations on the wire. */
const resolvedSessions = new Map<string, { realPubkey: string; expiresAt: number }>();

/** Verify an embedded attestation token and record `sessionPubkey → realPubkey`. */
export function recordAttestation(token: Event): void {
  try {
    if (!verifyEvent(token)) return;
    const parsed = JSON.parse(token.content) as { realPubkey?: unknown; expiresAt?: unknown };
    if (typeof parsed.realPubkey !== "string" || typeof parsed.expiresAt !== "number") return;
    // The token's own signer must be the real pubkey it claims.
    if (parsed.realPubkey !== token.pubkey) return;
    if (parsed.expiresAt * 1000 <= Date.now()) return;
    const d = token.tags.find((t) => t[0] === "d")?.[1];
    const sessionPubkey = d?.split(":").pop();
    if (!sessionPubkey) return;
    resolvedSessions.set(sessionPubkey, {
      realPubkey: parsed.realPubkey,
      expiresAt: parsed.expiresAt,
    });
  } catch {
    /* malformed token — ignore */
  }
}

/** Resolve a session pubkey to its attested real pubkey, if seen and unexpired. */
export function resolveAttested(sessionPubkey: string): { realPubkey: string } | null {
  const entry = resolvedSessions.get(sessionPubkey);
  if (!entry || entry.expiresAt * 1000 <= Date.now()) return null;
  return { realPubkey: entry.realPubkey };
}

// ── Provider ────────────────────────────────────────────

/** Tags updates applied from a relay so they aren't re-broadcast. */
const REMOTE_ORIGIN = Symbol("nostr-yjs-remote");
const SYNC_STEP_INTERVAL_MS = 60_000;
const PRESENCE_HEARTBEAT_MS = 15_000;
const PRESENCE_THROTTLE_MS = 200;

/**
 * Nostr-backed transport for a Yjs document. Mirrors
 * `nostr-docs/src/collab/NostrYjsProvider.ts` against `@formstr/core`'s
 * runtime so it works identically in the browser and in Node.
 */
export class NostrYjsProvider {
  readonly awareness: Awareness;
  readonly sessionPubkey: string;
  lastSyncRequestAt: number | null = null;

  private readonly room: string;
  private readonly env: YEnv;
  private readonly ydoc: Y.Doc;
  private readonly relays: string[];
  private readonly keys: CollabSessionKeys;
  private sub: { unsub(): void } | null = null;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private presenceThrottle: ReturnType<typeof setTimeout> | null = null;
  private pendingPresenceClients = new Set<number>();
  private destroyed = false;

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === REMOTE_ORIGIN) return;
    const encoder = this.env.encoding.createEncoder();
    this.env.sync.writeUpdate(encoder, update);
    this.publishOp(this.env.encoding.toUint8Array(encoder));
  };

  private readonly onOnline = () => this.sendSyncStep1();

  private readonly onAwarenessUpdate = (
    change: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === REMOTE_ORIGIN) return;
    [...change.added, ...change.updated, ...change.removed].forEach((c) =>
      this.pendingPresenceClients.add(c),
    );
    if (this.presenceThrottle) return;
    this.presenceThrottle = setTimeout(() => {
      this.presenceThrottle = null;
      const clients = [...this.pendingPresenceClients];
      this.pendingPresenceClients.clear();
      if (clients.length === 0) return;
      this.publishPresence(this.env.awareness.encodeAwarenessUpdate(this.awareness, clients));
    }, PRESENCE_THROTTLE_MS);
  };

  constructor(
    env: YEnv,
    opts: { docAddress: string; viewKey: string; ydoc: Y.Doc; relays: string[]; keys: CollabSessionKeys },
  ) {
    this.env = env;
    this.room = collabRoom(opts.viewKey);
    this.ydoc = opts.ydoc;
    this.relays = opts.relays;
    this.keys = opts.keys;
    this.sessionPubkey = opts.keys.sessionPubkey;
    this.awareness = new env.awareness.Awareness(this.ydoc);
    // Only the session pubkey — names are resolved via attestation, never from
    // self-asserted awareness state.
    this.awareness.setLocalStateField("user", { sessionPubkey: this.sessionPubkey });
  }

  connect(): void {
    this.ydoc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);

    this.sub = nostrRuntime.subscribe(
      this.relays,
      [{ kinds: [PAGES_KINDS.crdtOp, PAGES_KINDS.presence], "#a": [this.room] } as Filter],
      { onEvent: (event) => void this.handleIncoming(event) },
    );

    this.sendSyncStep1();
    this.syncInterval = setInterval(() => this.sendSyncStep1(), SYNC_STEP_INTERVAL_MS);
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
    this.heartbeatInterval = setInterval(() => {
      this.publishPresence(
        this.env.awareness.encodeAwarenessUpdate(this.awareness, [this.ydoc.clientID]),
      );
    }, PRESENCE_HEARTBEAT_MS);
  }

  private sendSyncStep1(): void {
    const encoder = this.env.encoding.createEncoder();
    this.env.sync.writeSyncStep1(encoder, this.ydoc);
    this.publishOp(this.env.encoding.toUint8Array(encoder));
    this.lastSyncRequestAt = Date.now();
  }

  private async handleIncoming(event: Event): Promise<void> {
    if (this.destroyed) return;
    if (event.pubkey === this.sessionPubkey) return; // self-echo guard

    // Authorization = possession of the viewKey: only a viewKey holder can
    // produce ciphertext that decrypts. The attestation travels inside it.
    let bytes: Uint8Array;
    try {
      const decrypted = await decryptWithViewKey(this.keys.viewKey, event.content);
      let messageB64 = decrypted;
      try {
        const parsed = JSON.parse(decrypted) as { a?: Event; m?: unknown };
        if (parsed && typeof parsed.m === "string") {
          if (parsed.a) recordAttestation(parsed.a);
          messageB64 = parsed.m;
        }
      } catch {
        // not JSON — legacy raw-base64 payload
      }
      bytes = fromBase64(messageB64);
    } catch {
      return;
    }

    if (event.kind === PAGES_KINDS.presence) {
      try {
        this.env.awareness.applyAwarenessUpdate(this.awareness, bytes, REMOTE_ORIGIN);
      } catch {
        /* malformed presence */
      }
      return;
    }

    try {
      const decoder = this.env.decoding.createDecoder(bytes);
      const replyEncoder = this.env.encoding.createEncoder();
      this.env.sync.readSyncMessage(decoder, replyEncoder, this.ydoc, REMOTE_ORIGIN, () => {
        /* malformed update — ignored */
      });
      if (this.env.encoding.hasContent(replyEncoder)) {
        this.publishOp(this.env.encoding.toUint8Array(replyEncoder));
      }
    } catch {
      /* malformed CRDT-op payload — dropped */
    }
  }

  private publishOp(bytes: Uint8Array): void {
    this.publish(PAGES_KINDS.crdtOp, bytes);
  }

  private publishPresence(bytes: Uint8Array): void {
    this.publish(PAGES_KINDS.presence, bytes);
  }

  /** Encrypt + sign one op/presence and publish it best-effort. */
  private publish(kind: number, bytes: Uint8Array): void {
    const payload = JSON.stringify({ a: this.keys.attestation, m: toBase64(bytes) });
    void encryptWithViewKey(this.keys.viewKey, payload).then((content) => {
      const event = finalizeEvent(
        {
          kind,
          tags: [["a", this.room]],
          content,
          created_at: Math.floor(Date.now() / 1000),
        },
        this.keys.sessionSecretKey,
      );
      // Ephemeral loss is tolerable — the periodic sync-step round-trip reconciles.
      nostrRuntime.publish(this.relays, event).catch(() => {
        /* best-effort */
      });
    });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.syncInterval) clearInterval(this.syncInterval);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.presenceThrottle) {
      clearTimeout(this.presenceThrottle);
      this.presenceThrottle = null;
    }
    this.ydoc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    const clientId = this.ydoc.clientID;
    this.env.awareness.removeAwarenessStates(this.awareness, [clientId], "tab closed");
    this.publishPresence(this.env.awareness.encodeAwarenessUpdate(this.awareness, [clientId]));
    this.awareness.destroy();
    this.sub?.unsub();
    this.sub = null;
  }
}

// ── Live session ────────────────────────────────────────

/** The ProseMirror document lives in this Yjs fragment name (TipTap default). */
const FRAGMENT = "default";

export interface CollabPeer {
  sessionPubkey: string;
  realPubkey: string | null;
}

export interface CollabSession {
  /** Stable id for tool calls — the document's root address. */
  id: string;
  address: string;
  room: string;
  viewKey: string;
  sessionPubkey: string;
  realPubkey: string | null;
  relays: string[];
  ydoc: Y.Doc;
  awareness: Awareness;
  provider: NostrYjsProvider;
  /** Yjs module, kept so fragment helpers need no second import. */
  Y: typeof import("yjs");
}

const sessions = new Map<string, CollabSession>();

/**
 * Build a connected transport for an existing Y.Doc without registering it in
 * the process session table. Used by `openCollabSession` and by callers that
 * manage their own docs (tests, embedders).
 */
export async function createCollabProvider(opts: {
  docAddress: string;
  viewKey: string;
  ydoc: Y.Doc;
  relays: string[];
}): Promise<NostrYjsProvider> {
  const env = await loadYEnv();
  const keys = await getOrCreateSessionKeys(opts.viewKey, opts.docAddress);
  const provider = new NostrYjsProvider(env, { ...opts, keys });
  provider.connect();
  return provider;
}

export interface OpenCollabOptions {
  /** Root address `33457:<owner>:<d>`. */
  address: string;
  viewKey: string;
  /** Markdown tip to seed an empty Y.Doc from (the durable baseline). */
  seedMarkdown?: string;
  relays?: string[];
  /** How long to wait for a peer's live state before seeding from Markdown. */
  graceMs?: number;
}

/**
 * Open (or reuse) a live collaboration session for a document: connect to the
 * room, then seed an empty Y.Doc from the Markdown snapshot if no peer state
 * arrived within the grace window (two clients seeding the same Markdown would
 * duplicate the document, so we wait first).
 */
export async function openCollabSession(opts: OpenCollabOptions): Promise<CollabSession> {
  const existing = sessions.get(opts.address);
  if (existing) return existing;

  const env = await loadYEnv();
  const ydoc = new env.Y.Doc();
  const relays = opts.relays ?? relayManager.getRelaysForModule("pages");
  const keys = await getOrCreateSessionKeys(opts.viewKey, opts.address);
  const provider = new NostrYjsProvider(env, {
    docAddress: opts.address,
    viewKey: opts.viewKey,
    ydoc,
    relays,
    keys,
  });

  const session: CollabSession = {
    id: opts.address,
    address: opts.address,
    room: collabRoom(opts.viewKey),
    viewKey: opts.viewKey,
    sessionPubkey: keys.sessionPubkey,
    realPubkey: keys.realPubkey,
    relays,
    ydoc,
    awareness: provider.awareness,
    provider,
    Y: env.Y,
  };
  sessions.set(session.id, session);
  provider.connect();

  await new Promise((r) => setTimeout(r, opts.graceMs ?? 1500));
  if (opts.seedMarkdown && fragmentLength(ydoc) === 0 && session.awareness.getStates().size <= 1) {
    replaceCollabDocument(session, opts.seedMarkdown);
  }
  return session;
}

export function getCollabSession(id: string): CollabSession | undefined {
  return sessions.get(id);
}

export function listCollabSessions(): string[] {
  return [...sessions.keys()];
}

export function closeCollabSession(id: string): boolean {
  const session = sessions.get(id);
  if (!session) return false;
  session.provider.destroy();
  session.ydoc.destroy();
  sessions.delete(id);
  return true;
}

export function closeAllCollabSessions(): void {
  for (const id of [...sessions.keys()]) closeCollabSession(id);
}

/** Peers currently present in the session (resolved to real pubkeys when attested). */
export function listCollabPeers(session: CollabSession): CollabPeer[] {
  const peers: CollabPeer[] = [];
  session.awareness.getStates().forEach((state) => {
    const sessionPubkey = (state as { user?: { sessionPubkey?: string } })?.user?.sessionPubkey;
    if (!sessionPubkey) return;
    peers.push({ sessionPubkey, realPubkey: resolveAttested(sessionPubkey)?.realPubkey ?? null });
  });
  return peers;
}

/**
 * Publish the current document as a durable Markdown snapshot (kind 33457),
 * viewKey-encrypted, signed by the configured signer. Yjs is ephemeral, so this
 * is what survives a session; an editor's snapshot lands in their own author
 * slot (the same per-author model as the shared app).
 */
export async function publishCollabSnapshot(session: CollabSession, markdown?: string): Promise<Event> {
  const ref = parseRootAddress(session.address);
  if (!ref) throw new Error(`Not a valid document address: ${session.address}`);
  const signer = await signerManager.getSigner();
  const content = markdown ?? readCollabMarkdown(session);
  const signed = (await signer.signEvent({
    kind: PAGES_KINDS.document,
    created_at: Math.floor(Date.now() / 1000),
    tags: contentTags(ref.d, session.viewKey),
    content: await encryptWithViewKey(session.viewKey, content),
  })) as Event;
  await nostrRuntime.publish(session.relays, signed);
  return signed;
}

// ── ProseMirror-in-Yjs fragment I/O (schema-agnostic) ───

function fragmentLength(ydoc: Y.Doc): number {
  return ydoc.getXmlFragment(FRAGMENT).length;
}

/** Concatenated text of a node (recursing through paragraph/list wrappers). */
function nodeText(node: Y.XmlElement | Y.XmlText): string {
  if (!("nodeName" in node)) return (node as Y.XmlText).toString();
  const el = node as Y.XmlElement;
  let out = "";
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i) as Y.XmlElement | Y.XmlText | undefined;
    if (child) out += nodeText(child);
  }
  return out;
}

function headingLevel(el: Y.XmlElement): number {
  const raw = el.getAttribute("level");
  const level = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(level) && level >= 1 && level <= 6 ? level : 1;
}

/** Serialize one block node to Markdown. */
function blockToMarkdown(node: Y.XmlElement | Y.XmlText): string {
  if (!("nodeName" in node)) return (node as Y.XmlText).toString();
  const el = node as Y.XmlElement;
  switch (el.nodeName) {
    case "heading":
      return `${"#".repeat(headingLevel(el))} ${nodeText(el)}`;
    case "paragraph":
      return nodeText(el);
    case "blockquote":
      return nodeText(el)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "codeBlock": {
      const lang = el.getAttribute("language") ?? "";
      return "```" + lang + "\n" + nodeText(el) + "\n```";
    }
    case "horizontalRule":
      return "---";
    default:
      return nodeText(el);
  }
}

/** Serialize an entire Y.XmlFragment to Markdown (best-effort block subset). */
export function readCollabMarkdown(session: CollabSession): string {
  const frag = session.ydoc.getXmlFragment(FRAGMENT);
  const lines: string[] = [];
  for (let i = 0; i < frag.length; i++) {
    const node = frag.get(i) as Y.XmlElement | Y.XmlText | undefined;
    if (!node) continue;
    if (!("nodeName" in node)) {
      lines.push((node as Y.XmlText).toString());
      continue;
    }
    const el = node as Y.XmlElement;
    if (el.nodeName === "bulletList" || el.nodeName === "orderedList") {
      const marker = el.nodeName === "bulletList" ? "-" : "1.";
      const items: string[] = [];
      for (let j = 0; j < el.length; j++) {
        const item = el.get(j) as Y.XmlElement;
        items.push(`${marker} ${nodeText(item)}`);
      }
      lines.push(items.join("\n"));
      continue;
    }
    lines.push(blockToMarkdown(el));
  }
  return lines.join("\n\n");
}

function makeText(Ymod: typeof import("yjs"), text: string): Y.XmlText {
  const t = new Ymod.XmlText();
  if (text) t.insert(0, text);
  return t;
}

function makeBlock(
  Ymod: typeof import("yjs"),
  nodeName: string,
  text: string,
  attrs: Record<string, string | number> = {},
): Y.XmlElement {
  const el = new Ymod.XmlElement(nodeName);
  // Attribute values may be numbers (e.g. heading `level`); the default
  // Y.XmlElement generic only advertises strings, so widen the setter.
  const setAttr = el as unknown as { setAttribute(k: string, v: string | number): void };
  for (const [k, v] of Object.entries(attrs)) setAttr.setAttribute(k, v);
  el.insert(0, [makeText(Ymod, text)]);
  return el;
}

/**
 * Convert a Markdown subset to Yjs blocks. Supports headings, paragraphs,
 * bullet/ordered lists, blockquotes, fenced code blocks and horizontal rules —
 * the block types the editor renders. Inline emphasis is not reconstructed
 * (text is inserted verbatim); callers should treat this as a coarse writer.
 */
export function markdownToBlocks(
  Y: typeof import("yjs"),
  markdown: string,
): Array<Y.XmlElement> {
  const blocks: Y.XmlElement[] = [];
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;

  const isBlank = (l: string) => l.trim().length === 0;

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push(makeBlock(Y, "codeBlock", body.join("\n"), lang ? { language: lang } : {}));
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      const hr = new Y.XmlElement("horizontalRule");
      blocks.push(hr);
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(makeBlock(Y, "heading", heading[2].trim(), { level: heading[1].length }));
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const el = new Y.XmlElement("blockquote");
      el.insert(0, [makeBlock(Y, "paragraph", quote.join("\n"))]);
      blocks.push(el);
      continue;
    }

    const bullet = line.match(/^[-*+]\s+(.*)$/);
    if (bullet) {
      const list = new Y.XmlElement("bulletList");
      const items: Y.XmlElement[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^[-*+]\s+(.*)$/);
        if (!m) break;
        const item = new Y.XmlElement("listItem");
        item.insert(0, [makeBlock(Y, "paragraph", m[1])]);
        items.push(item);
        i++;
      }
      list.insert(0, items);
      blocks.push(list);
      continue;
    }

    const ordered = line.match(/^\d+[.)]\s+(.*)$/);
    if (ordered) {
      const list = new Y.XmlElement("orderedList");
      const items: Y.XmlElement[] = [];
      while (i < lines.length) {
        const m = lines[i].match(/^\d+[.)]\s+(.*)$/);
        if (!m) break;
        const item = new Y.XmlElement("listItem");
        item.insert(0, [makeBlock(Y, "paragraph", m[1])]);
        items.push(item);
        i++;
      }
      list.insert(0, items);
      blocks.push(list);
      continue;
    }

    // Paragraph: consume consecutive non-blank, non-special lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      !isBlank(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^[-*+]\s+/.test(lines[i]) &&
      !/^\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^```/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push(makeBlock(Y, "paragraph", para.join("\n")));
  }
  return blocks;
}

/** Replace the entire document with `markdown` (one Yjs transaction). */
export function replaceCollabDocument(session: CollabSession, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(FRAGMENT);
  const blocks = markdownToBlocks(session.Y, markdown);
  session.ydoc.transact(() => {
    if (frag.length > 0) frag.delete(0, frag.length);
    if (blocks.length > 0) frag.insert(0, blocks);
  });
}

/** Append `markdown` as new blocks at the end of the document. */
export function appendCollabDocument(session: CollabSession, markdown: string): void {
  const frag = session.ydoc.getXmlFragment(FRAGMENT);
  const blocks = markdownToBlocks(session.Y, markdown);
  if (blocks.length === 0) return;
  session.ydoc.transact(() => {
    frag.insert(frag.length, blocks);
  });
}
