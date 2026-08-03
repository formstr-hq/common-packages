import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { getConversationKey, encrypt } from "nostr-tools/nip44";

import { CALENDAR_KINDS } from "../kinds";
import { GiftWrapVerificationError } from "../contracts";
import { LocalSigner } from "./localSigner";
import { buildSelfSignedDeletion, createRumor, unwrapEvent, wrapEvent } from "./nip59";

const sender = generateSecretKey();
const recipient = generateSecretKey();
const senderSigner = new LocalSigner(sender);
const recipientSigner = new LocalSigner(recipient);

describe("wrapEvent / unwrapEvent", () => {
  it("round-trips a kind-14 rumor through seal and wrap", async () => {
    const wrap = await wrapEvent(
      { kind: CALENDAR_KINDS.rumor, content: "you are invited", tags: [["viewKey", "nsec1x"]] },
      senderSigner,
      getPublicKey(recipient),
      CALENDAR_KINDS.giftWrap,
    );

    expect(wrap.kind).toBe(1059);
    expect(wrap.pubkey).not.toBe(getPublicKey(sender));
    expect(wrap.tags).toContainEqual(["p", getPublicKey(recipient)]);

    const rumor = await unwrapEvent(wrap, recipientSigner);
    expect(rumor.kind).toBe(14);
    expect(rumor.pubkey).toBe(getPublicKey(sender));
    expect(rumor.content).toBe("you are invited");
    expect(rumor.tags).toContainEqual(["viewKey", "nsec1x"]);
  });

  it("carries extra outer tags in plaintext for server-side filtering", async () => {
    const wrap = await wrapEvent({ content: "hi" }, senderSigner, getPublicKey(recipient), 1059, {
      tags: [["k", "1052"]],
    });
    expect(wrap.tags).toContainEqual(["k", "1052"]);
  });

  it("hands the wrap's own signing nsec to the rumor builder", async () => {
    let captured = "";
    const wrap = await wrapEvent(
      (signingNsec) => {
        captured = signingNsec;
        return { content: "x", tags: [["signing_nsec", signingNsec]] };
      },
      senderSigner,
      getPublicKey(recipient),
      1059,
    );

    const decoded = nip19.decode(captured);
    expect(decoded.type).toBe("nsec");
    // The nsec must be the key that actually signed the wrap, or the recipient
    // cannot delete it.
    expect(getPublicKey(decoded.data as Uint8Array)).toBe(wrap.pubkey);
  });

  it("uses a different ephemeral key for every wrap", async () => {
    const a = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(recipient), 1059);
    const b = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(recipient), 1059);
    expect(a.pubkey).not.toBe(b.pubkey);
  });

  it("keeps jittered timestamps in the past", async () => {
    const before = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 25; i++) {
      const wrap = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(recipient), 1059, {
        timestamps: "jittered",
      });
      expect(wrap.created_at).toBeLessThanOrEqual(before + 1);
    }
  });

  it("defaults to real timestamps, matching what calendar.formstr.app publishes", async () => {
    const before = Math.floor(Date.now() / 1000);
    const wrap = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(recipient), 1059);
    expect(wrap.created_at).toBeGreaterThanOrEqual(before);
  });
});

describe("unwrapEvent verification", () => {
  /** Builds a wrap whose seal is signed by `sealSigner` but whose rumor claims `claimedAuthor`. */
  async function forge(claimedAuthor: string, sealKey: Uint8Array) {
    const rumor = createRumor({ kind: 14, content: "trust me" }, claimedAuthor);
    const sealSigner = new LocalSigner(sealKey);
    const seal = await sealSigner.signEvent({
      kind: 13,
      content: await sealSigner.nip44Encrypt(getPublicKey(recipient), JSON.stringify(rumor)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
    });
    const ephemeral = generateSecretKey();
    return finalizeEvent(
      {
        kind: 1059,
        content: encrypt(
          JSON.stringify(seal),
          getConversationKey(ephemeral, getPublicKey(recipient)),
        ),
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", getPublicKey(recipient)]],
      },
      ephemeral,
    );
  }

  it("rejects a rumor that claims an author other than the seal signer", async () => {
    // An attacker seals with their own key but claims the rumor came from the
    // victim's trusted colleague. Accepting it means trusting the view key.
    const attacker = generateSecretKey();
    const wrap = await forge(getPublicKey(sender), attacker);
    await expect(unwrapEvent(wrap, recipientSigner)).rejects.toThrow(GiftWrapVerificationError);
  });

  it("accepts a rumor whose claimed author is the seal signer", async () => {
    const wrap = await forge(getPublicKey(sender), sender);
    const rumor = await unwrapEvent(wrap, recipientSigner);
    expect(rumor.pubkey).toBe(getPublicKey(sender));
  });

  it("rejects a seal with a broken signature", async () => {
    const wrap = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(recipient), 1059);
    // Re-seal with a tampered signature by hand.
    const sealSigner = new LocalSigner(sender);
    const rumor = createRumor({ content: "x" }, getPublicKey(sender));
    const seal = await sealSigner.signEvent({
      kind: 13,
      content: await sealSigner.nip44Encrypt(getPublicKey(recipient), JSON.stringify(rumor)),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
    });
    seal.sig = "00".repeat(64);
    const ephemeral = generateSecretKey();
    const tampered = finalizeEvent(
      {
        kind: 1059,
        content: encrypt(
          JSON.stringify(seal),
          getConversationKey(ephemeral, getPublicKey(recipient)),
        ),
        created_at: wrap.created_at,
        tags: [["p", getPublicKey(recipient)]],
      },
      ephemeral,
    );
    await expect(unwrapEvent(tampered, recipientSigner)).rejects.toThrow(/signature/);
  });

  it("rejects an inner event that is not a seal", async () => {
    const notASeal = finalizeEvent(
      { kind: 1, content: "hello", created_at: Math.floor(Date.now() / 1000), tags: [] },
      sender,
    );
    const ephemeral = generateSecretKey();
    const wrap = finalizeEvent(
      {
        kind: 1059,
        content: encrypt(
          JSON.stringify(notASeal),
          getConversationKey(ephemeral, getPublicKey(recipient)),
        ),
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", getPublicKey(recipient)]],
      },
      ephemeral,
    );
    await expect(unwrapEvent(wrap, recipientSigner)).rejects.toThrow(/seal kind/);
  });

  it("rejects a wrap addressed to somebody else", async () => {
    const wrap = await wrapEvent({ content: "x" }, senderSigner, getPublicKey(generateSecretKey()), 1059);
    await expect(unwrapEvent(wrap, recipientSigner)).rejects.toThrow(GiftWrapVerificationError);
  });
});

describe("buildSelfSignedDeletion", () => {
  it("is authored by the wrap's own ephemeral key so NIP-09 honours it", async () => {
    let signingNsec = "";
    const wrap = await wrapEvent(
      (nsec) => {
        signingNsec = nsec;
        return { content: "x" };
      },
      senderSigner,
      getPublicKey(recipient),
      1059,
    );

    const deletion = buildSelfSignedDeletion(signingNsec, [wrap.id], 1059);
    expect(deletion.kind).toBe(5);
    expect(deletion.pubkey).toBe(wrap.pubkey);
    expect(deletion.tags).toContainEqual(["e", wrap.id]);
    expect(deletion.tags).toContainEqual(["k", "1059"]);
  });

  it("refuses a key that is not an nsec", () => {
    expect(() => buildSelfSignedDeletion(nip19.npubEncode(getPublicKey(sender)), ["x"], 1059)).toThrow(
      /Expected an nsec/,
    );
  });
});
