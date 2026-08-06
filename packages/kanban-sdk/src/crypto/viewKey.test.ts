import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { describe, expect, it } from "vitest";

import {
  decryptWithViewKey,
  encryptWithViewKey,
  generateViewKey,
  viewKeyFromNsec,
} from "./viewKey";

describe("generateViewKey", () => {
  it("returns matching nsec, hex pubkey, and raw secret", () => {
    const key = generateViewKey();
    expect(key.nsec.startsWith("nsec1")).toBe(true);
    expect(key.pubkey).toHaveLength(64);
    expect(key.pubkey).toBe(key.pubkey.toLowerCase());
    expect(getPublicKey(key.secret)).toBe(key.pubkey);
    expect(nip19.decode(key.nsec).data).toEqual(key.secret);
  });

  it("never repeats", () => {
    expect(generateViewKey().nsec).not.toBe(generateViewKey().nsec);
  });
});

describe("viewKeyFromNsec", () => {
  it("recovers the full key from the nsec alone", () => {
    const key = generateViewKey();
    const recovered = viewKeyFromNsec(key.nsec);
    expect(recovered.pubkey).toBe(key.pubkey);
    expect(recovered.nsec).toBe(key.nsec);
    expect(recovered.secret).toEqual(key.secret);
  });

  it("rejects an npub — a view key is a secret, and a silent accept would publish plaintext", () => {
    const npub = nip19.npubEncode(getPublicKey(generateSecretKey()));
    expect(() => viewKeyFromNsec(npub)).toThrow(/Expected an nsec/);
  });
});

describe("encryptWithViewKey", () => {
  it("round-trips for anyone holding the nsec", async () => {
    const key = generateViewKey();
    const ciphertext = await encryptWithViewKey(key.nsec, "Q3 Roadmap");
    expect(ciphertext).not.toContain("Q3 Roadmap");
    expect(await decryptWithViewKey(key.nsec, ciphertext)).toBe("Q3 Roadmap");
  });

  it("is self-encryption: a holder of the same nsec decrypts, a different key does not", async () => {
    const key = generateViewKey();
    const ciphertext = await encryptWithViewKey(key.nsec, "secret");
    expect(await decryptWithViewKey(viewKeyFromNsec(key.nsec).nsec, ciphertext)).toBe("secret");
    await expect(decryptWithViewKey(generateViewKey().nsec, ciphertext)).rejects.toThrow();
  });
});
