import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  KIND_GIFTWRAP,
  KIND_SEAL,
  messageStringToBytes,
  WRAP_KEY_TAG,
} from "../src/index.js";
import { resolveRecipient, sendMail } from "../src/send.js";
import { unwrapMail } from "../src/unwrap.js";
import type { SimplePool } from "nostr-tools";

/**
 * sendMail is unwrapMail's mirror: every test here runs the chain straight
 * back through unwrapMail (the production verification path) instead of
 * asserting on internals, plus relay-transport tests against an injected pool.
 * Keys are throwaway per test — never a real identity.
 */
const keypair = () => {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
};

describe("sendMail — rumor/seal/wrap construction", () => {
  it("produces a wrap that unwraps (loopback) with matching fields", async () => {
    const sender = keypair();
    const recipient = keypair();
    const now = 1791360000;

    const result = await sendMail(sender.secretKey, {
      to: recipient.pubkey,
      subject: "loopback test",
      text: "hello from sendMail",
      from: "irona@mailstr.app",
      relays: [],
      now,
    });

    expect(result.recipient).toBe(recipient.pubkey);
    expect(result.wrap.kind).toBe(KIND_GIFTWRAP);
    expect(result.wrap.tags).toContainEqual(["p", recipient.pubkey]);

    const unwrapped = unwrapMail(result.wrap, recipient.secretKey);
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.seal.kind).toBe(KIND_SEAL);
    expect(unwrapped.rumor.kind).toBe(1301);
    expect(unwrapped.rumor.pubkey).toBe(sender.pubkey);
    expect(unwrapped.rumor.created_at).toBe(now);
    const raw = new TextDecoder().decode(messageStringToBytes(unwrapped.rumor.content));
    expect(raw).toContain("Subject: loopback test");
    expect(raw).toContain("From: irona@mailstr.app");
    expect(raw).toContain("hello from sendMail");
    // wrapkey tag present and derives to the wrap author (rule 6)
    const wrapSecret = unwrapped.rumor.tags.find((t) => t[0] === WRAP_KEY_TAG)?.[1];
    expect(wrapSecret).toBeDefined();
    expect(getPublicKey(Buffer.from(wrapSecret!, "hex"))).toBe(result.wrap.pubkey);
  });

  it("accepts npub destinations and normalizes to hex", async () => {
    const sender = keypair();
    const recipient = keypair();
    const result = await sendMail(sender.secretKey, {
      to: nip19.npubEncode(recipient.pubkey),
      text: "npub destination",
      relays: [],
    });
    expect(result.recipient).toBe(recipient.pubkey);
  });

  it("rejects garbage destinations", async () => {
    const sender = keypair();
    await expect(
      sendMail(sender.secretKey, { to: "not-a-key", text: "x", relays: [] }),
    ).rejects.toThrow(/destination/);
  });

  it("requires text or raw", async () => {
    const sender = keypair();
    await expect(
      sendMail(sender.secretKey, { to: getPublicKey(sender.secretKey), relays: [] }),
    ).rejects.toThrow(/`text`|raw/);
  });
});

describe("sendMail — transport", () => {
  it("publishes the wrap to every relay via the injected pool", async () => {
    const sender = keypair();
    const recipient = keypair();
    const published: { relays: string[]; kinds: number[] }[] = [];
    const fakePool = {
      publish: (relays: string[], ev: { kind: number }) => {
        published.push({ relays, kinds: [ev.kind] });
        // Real SimplePool.publish returns one promise per relay, in order.
        return relays.map(() => Promise.resolve(""));
      },
    } as unknown as Pick<SimplePool, "publish">;

    const result = await sendMail(sender.secretKey, {
      to: recipient.pubkey,
      text: "pool test",
      relays: ["wss://a", "wss://b"],
      pool: fakePool,
    });

    expect(published).toHaveLength(1);
    expect(published[0].relays).toEqual(["wss://a", "wss://b"]);
    expect(published[0].kinds).toEqual([KIND_GIFTWRAP]);
    expect(result.results.map((r) => r.relay)).toEqual(["wss://a", "wss://b"]);
    expect(result.results.every((r) => r.ok)).toBe(true);
  });

  it("defaults to the default inbox relays when none are passed", async () => {
    const sender = keypair();
    const recipient = keypair();
    let seen: string[] = [];
    const fakePool = {
      publish: (relays: string[]) => {
        seen = relays;
        return relays.map(() => Promise.resolve(""));
      },
    } as unknown as Pick<SimplePool, "publish">;
    await sendMail(sender.secretKey, { to: recipient.pubkey, text: "defaults", pool: fakePool });
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("resolveRecipient", () => {
  it("keeps hex and accepts npub", () => {
    const hex = "a".repeat(64);
    expect(resolveRecipient(hex)).toBe(hex);
    expect(resolveRecipient(nip19.npubEncode(hex))).toBe(hex);
  });
});