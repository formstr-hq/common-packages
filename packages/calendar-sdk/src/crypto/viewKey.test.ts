import { describe, expect, it } from "vitest";
import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { selfDecrypt, selfEncrypt } from "./nip44";
import {
  decodeViewKey,
  decryptWithViewKey,
  encodeViewKey,
  encryptWithViewKey,
  generateViewKey,
} from "./viewKey";

describe("view keys", () => {
  it("generates a key and its nsec encoding together", () => {
    const key = generateViewKey();
    expect(key.nsec.startsWith("nsec1")).toBe(true);
    expect(decodeViewKey(key.nsec)).toEqual(key.secretKey);
  });

  it("round-trips a payload through the nsec form", () => {
    const { nsec } = generateViewKey();
    const payload = [["title", "Standup"], ["start", 1_800_000_000]];
    expect(decryptWithViewKey(nsec, encryptWithViewKey(nsec, payload))).toEqual(payload);
  });

  it("is readable by anyone holding the key, not just the author", () => {
    // This is the whole point: the key travels in invitations, so a second
    // party with only the nsec must be able to read the ciphertext.
    const { secretKey, nsec } = generateViewKey();
    const ciphertext = selfEncrypt(secretKey, { hello: "world" });
    expect(decryptWithViewKey(nsec, ciphertext)).toEqual({ hello: "world" });
  });

  it("is not readable with a different key", () => {
    const ciphertext = encryptWithViewKey(generateViewKey().nsec, { secret: true });
    expect(() => decryptWithViewKey(generateViewKey().nsec, ciphertext)).toThrow();
  });

  it("rejects a non-nsec key rather than failing later inside NIP-44", () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    expect(() => decodeViewKey(npub)).toThrow(/Expected an nsec/);
  });

  it("encodes raw bytes back to the wire form", () => {
    const sk = generateSecretKey();
    expect(decodeViewKey(encodeViewKey(sk))).toEqual(sk);
  });
});

describe("selfEncrypt / selfDecrypt", () => {
  it("derives the conversation key from the secret key and its own pubkey", () => {
    const sk = generateSecretKey();
    const ciphertext = selfEncrypt(sk, ["a", "b"]);
    expect(selfDecrypt(sk, ciphertext)).toEqual(["a", "b"]);
    // Sanity: the pubkey side is derived, not supplied — a caller cannot get
    // this wrong by passing the wrong counterparty.
    expect(getPublicKey(sk)).toHaveLength(64);
  });
});
