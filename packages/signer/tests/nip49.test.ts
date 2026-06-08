import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  decryptNcryptsec,
  encryptSecretKey,
  generateAccount,
} from '../src/nip49.js';

describe('nip49', () => {
  it('encrypt → decrypt round-trip recovers the original secret key', () => {
    const sk = generateSecretKey();
    const ncryptsec = encryptSecretKey(sk, 'correct horse battery staple');
    const recovered = decryptNcryptsec(ncryptsec, 'correct horse battery staple');
    expect(recovered).toEqual(sk);
  });

  it('decrypt with the wrong passphrase throws', () => {
    const sk = generateSecretKey();
    const ncryptsec = encryptSecretKey(sk, 'right');
    expect(() => decryptNcryptsec(ncryptsec, 'wrong')).toThrow();
  });

  it('generateAccount produces internally consistent fields', () => {
    const acc = generateAccount('my-passphrase');
    expect(acc.secretKey).toBeInstanceOf(Uint8Array);
    expect(acc.secretKey.length).toBe(32);
    expect(getPublicKey(acc.secretKey)).toBe(acc.pubkey);
    expect(acc.npub).toMatch(/^npub1/);
    expect(acc.ncryptsec).toMatch(/^ncryptsec1/);
    expect(decryptNcryptsec(acc.ncryptsec, 'my-passphrase')).toEqual(acc.secretKey);
  });

  it('generateAccount produces distinct keys across calls', () => {
    const a = generateAccount('p');
    const b = generateAccount('p');
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});
