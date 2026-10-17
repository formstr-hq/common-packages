import { webcrypto } from "node:crypto";

import { LocalSigner, resetNostrRuntime, setNostrRuntime, signerManager } from "@formstr/core";
import type { Event, Filter } from "nostr-tools";
import { getPublicKey } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Yjs from "yjs";

// vitest's node environment omits the `crypto` global on Node 18; nostr-tools'
// secret-key generation needs it.
if (!(globalThis as { crypto?: Crypto }).crypto?.getRandomValues) {
  (globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto;
}

// SignerManager persists the active account to localStorage.
if (typeof (globalThis as { localStorage?: Storage }).localStorage === "undefined") {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
}

import {
  appendCollabDocument,
  closeAllCollabSessions,
  createCollabProvider,
  getOrCreateSessionKeys,
  openCollabSession,
  readCollabMarkdown,
  recordAttestation,
  resolveAttested,
} from "./realtime";

const VK = "33".repeat(32);
const SEC = "22".repeat(32);
const PUB = getPublicKey(hexToBytes(SEC));

/** In-memory relay bus: publish fans out to matching live subscriptions. */
function makeBus() {
  const subs: { filters: Filter[]; onEvent?: (e: Event) => void }[] = [];
  const published: Event[] = [];
  const matches = (f: Filter, e: Event): boolean => {
    if (f.kinds && !f.kinds.includes(e.kind)) return false;
    if (f["#a"] && !e.tags.some((t) => t[0] === "a" && f["#a"]!.includes(t[1]))) return false;
    return true;
  };
  return {
    published,
    runtime: {
      subscribe(_relays: string[], filters: Filter[], options?: { onEvent?: (e: Event) => void }) {
        const entry = { filters, onEvent: options?.onEvent };
        subs.push(entry);
        return {
          unsub: () => {
            const i = subs.indexOf(entry);
            if (i >= 0) subs.splice(i, 1);
          },
        };
      },
      async publish(_relays: string[], event: Event) {
        published.push(event);
        for (const s of [...subs]) {
          if (s.filters.some((f) => matches(f, event))) {
            queueMicrotask(() => s.onEvent?.(event));
          }
        }
      },
      async fetchOne() {
        return null;
      },
      async querySync() {
        return [];
      },
      dispose() {},
    },
  };
}

let bus = makeBus();

beforeEach(() => {
  bus = makeBus();
  setNostrRuntime(bus.runtime);
  signerManager.setActiveSigner(new LocalSigner(hexToBytes(SEC)), "local", PUB);
});

afterEach(() => {
  closeAllCollabSessions();
  resetNostrRuntime();
});

/** Flatten all text in a doc's default fragment. */
function docText(ydoc: Yjs.Doc): string {
  const frag = ydoc.getXmlFragment("default");
  let out = "";
  const walk = (n: unknown) => {
    const node = n as { nodeName?: string; length: number; get(i: number): unknown; toString(): string };
    if (!node.nodeName) {
      out += node.toString();
      return;
    }
    for (let i = 0; i < node.length; i++) walk(node.get(i));
  };
  for (let i = 0; i < frag.length; i++) walk(frag.get(i));
  return out;
}

async function waitFor(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("collab session — document I/O", () => {
  it("seeds an empty Y.Doc from the Markdown tip and round-trips blocks", async () => {
    const session = await openCollabSession({
      address: `33457:${PUB}:seed`,
      viewKey: VK,
      seedMarkdown: "# Hello\n\nworld",
      graceMs: 0,
      relays: ["wss://test"],
    });
    expect(readCollabMarkdown(session)).toBe("# Hello\n\nworld");

    appendCollabDocument(session, "## More\n\n- a\n- b");
    expect(readCollabMarkdown(session)).toBe("# Hello\n\nworld\n\n## More\n\n- a\n- b");
  });

  it("reuses an open session for the same address", async () => {
    const first = await openCollabSession({
      address: `33457:${PUB}:reuse`,
      viewKey: VK,
      graceMs: 0,
      relays: ["wss://test"],
    });
    const second = await openCollabSession({
      address: `33457:${PUB}:reuse`,
      viewKey: VK,
      graceMs: 0,
      relays: ["wss://test"],
    });
    expect(second).toBe(first);
  });
});

describe("collab session — live sync over the relay bus", () => {
  it("merges a peer's edit through Yjs and publishes a CRDT op", async () => {
    const ydocA = new Yjs.Doc();
    const ydocB = new Yjs.Doc();
    const providerA = await createCollabProvider({
      docAddress: `33457:${PUB}:syncA`,
      viewKey: VK,
      ydoc: ydocA,
      relays: ["wss://test"],
    });
    const providerB = await createCollabProvider({
      docAddress: `33457:${PUB}:syncB`,
      viewKey: VK,
      ydoc: ydocB,
      relays: ["wss://test"],
    });

    // A inserts a paragraph; B must receive it purely over the bus.
    const paragraph = new Yjs.XmlElement("paragraph");
    const text = new Yjs.XmlText();
    text.insert(0, "hello from A");
    paragraph.insert(0, [text]);
    ydocA.getXmlFragment("default").insert(0, [paragraph]);

    await waitFor(() => docText(ydocB).includes("hello from A"));

    expect(bus.published.some((e) => e.kind === 22457)).toBe(true);
    expect(bus.published.some((e) => e.kind === 24578)).toBe(false); // no presence flood

    providerA.destroy();
    providerB.destroy();
  });
});

describe("collab session — attestation", () => {
  it("binds a session key to the configured real pubkey", async () => {
    const keys = await getOrCreateSessionKeys(VK, `33457:${PUB}:attest`);
    expect(keys.attestation).not.toBeNull();
    recordAttestation(keys.attestation!);
    expect(resolveAttested(keys.sessionPubkey)?.realPubkey).toBe(PUB);
  });
});
