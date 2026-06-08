import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { LocalSigner } from '../src/core/localSigner.js';

describe('LocalSigner', () => {
  it('getPublicKey returns the correct hex pubkey', async () => {
    const sk = generateSecretKey();
    const signer = new LocalSigner(sk);
    expect(await signer.getPublicKey()).toBe(getPublicKey(sk));
  });

  it('signEvent produces a verifiable event', async () => {
    const sk = generateSecretKey();
    const signer = new LocalSigner(sk);
    const event = await signer.signEvent({
      kind: 1,
      content: 'gm',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(event.id).toMatch(/^[a-f0-9]{64}$/);
    expect(event.sig).toMatch(/^[a-f0-9]{128}$/);
    expect(event.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(event)).toBe(true);
  });

  it('nip44 encrypt/decrypt round-trips between two parties', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const a = new LocalSigner(skA);
    const b = new LocalSigner(skB);
    const pubA = await a.getPublicKey();
    const pubB = await b.getPublicKey();
    const ciphertext = await a.nip44Encrypt(pubB, 'hello bob');
    const recovered = await b.nip44Decrypt(pubA, ciphertext);
    expect(recovered).toBe('hello bob');
  });

  it('nip04 encrypt/decrypt round-trips between two parties', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    const a = new LocalSigner(skA);
    const b = new LocalSigner(skB);
    const pubA = await a.getPublicKey();
    const pubB = await b.getPublicKey();
    const ciphertext = await a.nip04Encrypt(pubB, 'hello bob');
    const recovered = await b.nip04Decrypt(pubA, ciphertext);
    expect(recovered).toBe('hello bob');
  });

  it('does not expose the secret key on the instance', () => {
    const sk = generateSecretKey();
    const signer = new LocalSigner(sk);
    expect(Object.keys(signer)).toEqual([]);
    expect((signer as unknown as { secretKey?: unknown }).secretKey).toBeUndefined();
    const json = JSON.stringify(signer);
    expect(json).not.toContain(
      Array.from(sk)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(''),
    );
  });
});
