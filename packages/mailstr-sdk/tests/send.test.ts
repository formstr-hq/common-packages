import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import {
  KIND_GIFTWRAP,
  KIND_SEAL,
  messageStringToBytes,
  WRAP_KEY_TAG,
} from "../src/index.js";
import { resolveDestination, resolveRecipient, sendMail, sendMailWith } from "../src/send.js";
import { unwrapMail, unwrapMailWith } from "../src/unwrap.js";
import type { SimplePool } from "nostr-tools";
import { makeMailSigner } from "./helpers/synthetic.js";

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

    // Pass the same frozen clock: `now` is fixed for sendMail, but unwrapMail
    // defaults to the wall clock and rejects rumors older than
    // MAX_RUMOR_AGE_SECONDS (300), which made this assertion a time bomb.
    const unwrapped = unwrapMail(result.wrap, recipient.secretKey, { now });
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

  it("refuses non-key forms", () => {
    expect(() => resolveRecipient("friend@example.com")).toThrow(/destination/);
  });
});

describe("resolveDestination", () => {
  it("classifies keys, npubs, and email addresses", () => {
    const hex = "b".repeat(64);
    expect(resolveDestination(hex)).toEqual({ type: "nostr", pubkey: hex });
    expect(resolveDestination(nip19.npubEncode(hex))).toEqual({ type: "nostr", pubkey: hex });
    expect(resolveDestination("Person@Example.COM")).toEqual({
      type: "email",
      // Localpart preserved as written (the bridge hands the original target
      // to postfix — address.ts splitAddress); domain normalized.
      address: "Person@example.com",
    });
  });

  it("refuses email-form mailstr-local recipients and garbage", () => {
    // The bridge refuses local domains (outbound.ts §6B) and a bare localpart
    // has no key — local recipients must be addressed by npub/hex.
    expect(() => resolveDestination("someone@mailstr.app")).toThrow(/mailstr\.app/);
    expect(() => resolveDestination("garbage")).toThrow(/destination/);
  });
});

describe("sendMail — email bridge", () => {
  it("wraps to the bridge key, carries deliver tags, publishes on bridge relays", async () => {
    const sender = keypair();
    const bridge = keypair();
    const published: { relays: string[]; kinds: number[] }[] = [];
    const fakePool = {
      publish: (relays: string[], ev: { kind: number }) => {
        published.push({ relays, kinds: [ev.kind] });
        return relays.map(() => Promise.resolve(""));
      },
    } as unknown as Pick<SimplePool, "publish">;

    const result = await sendMail(sender.secretKey, {
      to: "friend@outside.example",
      subject: "email bridge test",
      text: "hello over SMTP",
      from: "irona@mailstr.app",
      bridge: { pubkey: bridge.pubkey, relays: ["wss://br1", "wss://br2"] },
      pool: fakePool,
    });

    // Sealed and wrapped to the bridge key, not to a Nostr recipient.
    expect(result.recipient).toBe(bridge.pubkey);
    expect(result.wrap.tags[0]).toEqual(["p", bridge.pubkey]);
    expect(published).toHaveLength(1);
    expect(published[0].relays).toEqual(["wss://br1", "wss://br2"]);
    expect(published[0].kinds).toEqual([KIND_GIFTWRAP]);

    // The bridge unwraps with the same rules and reads deliver targets.
    const unwrapped = unwrapMail(result.wrap, bridge.secretKey);
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.rumor.tags).toContainEqual(["deliver", "friend@outside.example"]);
    const raw = new TextDecoder().decode(messageStringToBytes(unwrapped.rumor.content));
    expect(raw).toContain("To: friend@outside.example");
    expect(raw).toContain("Subject: email bridge test");
  });
});

describe("sendMailWith — the signer path", () => {
  it("round-trips a wrap through the recipient's signer, no secret key in the SDK", async () => {
    const sender = keypair();
    const recipient = keypair();
    const now = 1791360000;

    const result = await sendMailWith(makeMailSigner(sender.secretKey), {
      to: recipient.pubkey,
      subject: "signer loopback",
      text: "hello via signer",
      from: "irona@mailstr.app",
      relays: [],
      now,
    });

    expect(result.recipient).toBe(recipient.pubkey);
    expect(result.wrap.tags).toContainEqual(["p", recipient.pubkey]);

    // The recipient verifies through their own signer; the seal must have been
    // signed by the sender's key (author-mismatch would fire otherwise).
    const unwrapped = await unwrapMailWith(result.wrap, makeMailSigner(recipient.secretKey), { now });
    expect(unwrapped.ok).toBe(true);
    if (!unwrapped.ok) return;
    expect(unwrapped.seal.pubkey).toBe(sender.pubkey);
    expect(unwrapped.rumor.pubkey).toBe(sender.pubkey);
    const raw = new TextDecoder().decode(messageStringToBytes(unwrapped.rumor.content));
    expect(raw).toContain("Subject: signer loopback");
    expect(raw).toContain("From: irona@mailstr.app");
  });

  it("uses the signer's own pubkey as the rumor author and embed the true wrap key", async () => {
    const sender = keypair();
    const recipient = keypair();
    const result = await sendMailWith(makeMailSigner(sender.secretKey), {
      to: recipient.pubkey,
      text: "x",
      relays: [],
    });
    // The wrap key in the rumor must derive to the wrap author (rule 6).
    const wrapSecret = result.wrap.pubkey;
    expect(wrapSecret).toHaveLength(64);
    expect(result.wrap.kind).toBe(KIND_GIFTWRAP);
  });
});