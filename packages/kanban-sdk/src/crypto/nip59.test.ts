import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { fakeSigner } from "../../test/helpers";
import { createSeal, createWrap, unwrapEvent, wrapEvent, wrapManyEvents } from "./nip59";

const RUMOR = { kind: 53, content: "", tags: [["a", "32301:abc:board-1"]] };

describe("wrapEvent", () => {
  it("hides the payload behind an ephemeral author and p-tags the recipient", async () => {
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const bobPubkey = getPublicKey(bob);

    const wrap = await wrapEvent(RUMOR, fakeSigner(alice), bobPubkey, 1053);

    expect(wrap.kind).toBe(1053);
    expect(wrap.tags).toEqual([["p", bobPubkey]]);
    expect(wrap.pubkey).not.toBe(getPublicKey(alice));
    expect(wrap.pubkey).not.toBe(bobPubkey);
    expect(wrap.content).not.toContain("32301:abc:board-1");
  });

  it("round-trips to a rumor naming its real author", async () => {
    const alice = generateSecretKey();
    const bob = generateSecretKey();

    const wrap = await wrapEvent(RUMOR, fakeSigner(alice), getPublicKey(bob), 1053);
    const rumor = await unwrapEvent(wrap, fakeSigner(bob));

    expect(rumor.pubkey).toBe(getPublicKey(alice));
    expect(rumor.kind).toBe(53);
    expect(rumor.tags).toEqual([["a", "32301:abc:board-1"]]);
  });

  it("cannot be unwrapped by anyone else", async () => {
    const wrap = await wrapEvent(
      RUMOR,
      fakeSigner(generateSecretKey()),
      getPublicKey(generateSecretKey()),
      1053,
    );
    await expect(unwrapEvent(wrap, fakeSigner(generateSecretKey()))).rejects.toThrow();
  });

  it("jitters seal and wrap timestamps into the past only — relays reject future events", async () => {
    const now = Math.floor(Date.now() / 1000);
    const wrap = await wrapEvent(
      RUMOR,
      fakeSigner(generateSecretKey()),
      getPublicKey(generateSecretKey()),
      1053,
      { timestamps: "jittered" },
    );
    expect(wrap.created_at).toBeLessThanOrEqual(now);
    expect(wrap.created_at).toBeGreaterThan(now - 2 * 24 * 60 * 60 - 5);
  });

  it("keeps the rumor's real created_at even when the outer layers are jittered", async () => {
    // Recipients sort on the rumor's timestamp; jittering it would reorder history.
    const recipient = generateSecretKey();
    const wrap = await wrapEvent(
      { ...RUMOR, created_at: 1753600000 },
      fakeSigner(generateSecretKey()),
      getPublicKey(recipient),
      1053,
      { timestamps: "jittered" },
    );

    expect((await unwrapEvent(wrap, fakeSigner(recipient))).created_at).toBe(1753600000);
  });
});

describe("wrapManyEvents", () => {
  it("gives each recipient their own wrap of the same rumor", async () => {
    const alice = generateSecretKey();
    const bob = generateSecretKey();
    const carol = generateSecretKey();

    const wraps = await wrapManyEvents(RUMOR, fakeSigner(alice), [
      getPublicKey(bob),
      getPublicKey(carol),
    ]);

    expect(wraps).toHaveLength(2);
    expect((await unwrapEvent(wraps[0], fakeSigner(bob))).pubkey).toBe(getPublicKey(alice));
    expect((await unwrapEvent(wraps[1], fakeSigner(carol))).pubkey).toBe(getPublicKey(alice));
    await expect(unwrapEvent(wraps[0], fakeSigner(carol))).rejects.toThrow();
  });
});

describe("unwrapEvent verification", () => {
  it("rejects a seal that is not kind 13", async () => {
    const bob = generateSecretKey();
    const mallory = generateSecretKey();
    const fakeSeal = finalizeEvent(
      { kind: 14, created_at: 1, tags: [], content: "x" },
      mallory,
    ) as Event;
    const wrap = await createWrap(fakeSeal, getPublicKey(bob), 1053);

    await expect(unwrapEvent(wrap, fakeSigner(bob))).rejects.toThrow(/seal kind/);
  });

  it("rejects a seal whose signature does not verify", async () => {
    const bob = generateSecretKey();
    const seal = await createSeal(
      {
        kind: 53,
        created_at: 1,
        tags: [],
        content: "",
        pubkey: getPublicKey(generateSecretKey()),
        id: "",
      },
      fakeSigner(generateSecretKey()),
      getPublicKey(bob),
    );
    const tampered = { ...seal, sig: "0".repeat(128) } as Event;
    const wrap = await createWrap(tampered, getPublicKey(bob), 1053);

    await expect(unwrapEvent(wrap, fakeSigner(bob))).rejects.toThrow(/signature verification/);
  });

  it("rejects a rumor claiming an author who did not sign the seal — forged invitation", async () => {
    // Mallory seals a rumor that claims Alice wrote it. Without this check Bob
    // would accept a board key "from Alice" and trust it.
    const mallory = generateSecretKey();
    const alice = getPublicKey(generateSecretKey());
    const bob = generateSecretKey();

    const forgedRumor = {
      kind: 53,
      created_at: 1,
      tags: [["a", "32301:abc:board-1"]],
      content: "",
      pubkey: alice,
      id: "",
    };
    const seal = await createSeal(forgedRumor, fakeSigner(mallory), getPublicKey(bob));
    const wrap = await createWrap(seal, getPublicKey(bob), 1053);

    await expect(unwrapEvent(wrap, fakeSigner(bob))).rejects.toThrow(/does not match seal signer/);
  });
});
