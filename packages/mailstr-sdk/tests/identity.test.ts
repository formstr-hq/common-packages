import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { createIdentity, identityFromSecretKey } from '../src/index.js';

describe('identity', () => {
  it('createIdentity derives consistent public facts', () => {
    const id = createIdentity();
    expect(id.secretKey).toHaveLength(32);
    expect(id.secretKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(id.pubkey).toMatch(/^[0-9a-f]{64}$/);
    const decoded = nip19.decode(id.npub);
    expect(decoded.type).toBe("npub");
    expect(decoded.data).toBe(id.pubkey);
  });

  it('createIdentity never repeats a key', () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(a.secretKeyHex).not.toBe(b.secretKeyHex);
    expect(a.pubkey).not.toBe(b.pubkey);
  });

  it('restores from hex or bytes and agrees on the public facts', () => {
    const original = createIdentity();
    const fromHex = identityFromSecretKey(original.secretKeyHex);
    const fromBytes = identityFromSecretKey(original.secretKey);
    expect(fromHex.pubkey).toBe(original.pubkey);
    expect(fromHex.npub).toBe(original.npub);
    expect(fromBytes.pubkey).toBe(original.pubkey);
    expect(fromBytes.secretKeyHex).toBe(original.secretKeyHex);
    // Restored bytes are a copy — mutating the input afterwards is safe.
    expect(fromBytes.secretKey).not.toBe(original.secretKey);
  });

  it('rejects malformed secret keys', () => {
    expect(() => identityFromSecretKey('not-hex')).toThrow();
    expect(() => identityFromSecretKey('abcd')).toThrow(); // wrong length
    expect(() => identityFromSecretKey(new Uint8Array(31))).toThrow();
  });
});