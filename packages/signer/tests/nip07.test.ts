import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { createSigner, type WindowNostr } from '../src/index.js';
import type { StorageAdapter } from '../src/core/storage.js';
import { LocalSigner } from '../src/core/localSigner.js';

interface InspectableStorage extends StorageAdapter {
  dump(): Record<string, string>;
}

function makeMockStorage(): InspectableStorage {
  const data = new Map<string, string>();
  return {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => {
      data.set(k, v);
    },
    remove: (k) => {
      data.delete(k);
    },
    dump: () => Object.fromEntries(data),
  };
}

/**
 * Build a WindowNostr backed by a LocalSigner — simulates a real extension
 * holding a key on the user's behalf.
 */
function makeMockWindowNostr(secretKey: Uint8Array): WindowNostr {
  const local = new LocalSigner(secretKey);
  return {
    getPublicKey: () => local.getPublicKey(),
    signEvent: (e) => local.signEvent(e),
    nip04: {
      encrypt: (peer, text) => local.nip04Encrypt(peer, text),
      decrypt: (peer, ct) => local.nip04Decrypt(peer, ct),
    },
    nip44: {
      encrypt: (peer, text) => local.nip44Encrypt(peer, text),
      decrypt: (peer, ct) => local.nip44Decrypt(peer, ct),
    },
  };
}

const g = globalThis as { nostr?: WindowNostr };

describe('NIP-07 (window.nostr extension)', () => {
  let original: WindowNostr | undefined;

  beforeEach(() => {
    original = g.nostr;
  });

  afterEach(() => {
    g.nostr = original;
  });

  it('loginWithExtension throws when window.nostr is unavailable', async () => {
    g.nostr = undefined;
    const s = createSigner({ storage: makeMockStorage() });
    await expect(s.loginWithExtension()).rejects.toThrow(/NIP-07 extension not found/);
  });

  it('loginWithExtension creates an extension-method account with the pubkey from the extension', async () => {
    const sk = generateSecretKey();
    g.nostr = makeMockWindowNostr(sk);
    const s = createSigner({ storage: makeMockStorage() });

    const account = await s.loginWithExtension();
    expect(account.method).toBe('extension');
    expect(account.pubkey).toBe(getPublicKey(sk));
    expect(account.npub).toMatch(/^npub1/);
    expect(account.ncryptsec).toBeUndefined();
    expect(account.nip46).toBeUndefined();
  });

  it('signs events via the extension and the signature verifies', async () => {
    const sk = generateSecretKey();
    g.nostr = makeMockWindowNostr(sk);
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithExtension();

    const signed = await s.getActiveSigner()!.signEvent({
      kind: 1,
      content: 'from the extension',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(signed)).toBe(true);
  });

  it('delegates nip04 and nip44 encrypt/decrypt to the extension', async () => {
    const skA = generateSecretKey();
    const skB = generateSecretKey();
    g.nostr = makeMockWindowNostr(skA);
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithExtension();
    const active = s.getActiveSigner()!;

    const pubB = getPublicKey(skB);
    const pubA = getPublicKey(skA);
    const peerLocal = new LocalSigner(skB);

    const nip44ct = await active.nip44Encrypt(pubB, 'hi');
    expect(await peerLocal.nip44Decrypt(pubA, nip44ct)).toBe('hi');
    // Decrypt via the extension too, to exercise that path.
    const nip44CtFromPeer = await peerLocal.nip44Encrypt(pubA, 'hello back');
    expect(await active.nip44Decrypt(pubB, nip44CtFromPeer)).toBe('hello back');

    const nip04ct = await active.nip04Encrypt(pubB, 'yo');
    expect(await peerLocal.nip04Decrypt(pubA, nip04ct)).toBe('yo');
    const nip04CtFromPeer = await peerLocal.nip04Encrypt(pubA, 'sup');
    expect(await active.nip04Decrypt(pubB, nip04CtFromPeer)).toBe('sup');
  });

  it('throws when the extension does not expose nip04 or nip44', async () => {
    const sk = generateSecretKey();
    const partial = makeMockWindowNostr(sk);
    delete partial.nip04;
    delete partial.nip44;
    g.nostr = partial;
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithExtension();
    const active = s.getActiveSigner()!;

    const peerPubkey = getPublicKey(generateSecretKey());
    await expect(active.nip04Encrypt(peerPubkey, 'x')).rejects.toThrow(/nip04/);
    await expect(active.nip04Decrypt(peerPubkey, 'x')).rejects.toThrow(/nip04/);
    await expect(active.nip44Encrypt(peerPubkey, 'x')).rejects.toThrow(/nip44/);
    await expect(active.nip44Decrypt(peerPubkey, 'x')).rejects.toThrow(/nip44/);
  });

  it('persists the account with method:extension and no key material', async () => {
    const sk = generateSecretKey();
    g.nostr = makeMockWindowNostr(sk);
    const storage = makeMockStorage();
    const s = createSigner({ storage });
    await s.loginWithExtension();

    const arr = JSON.parse(storage.dump()['accounts']!);
    expect(arr).toHaveLength(1);
    expect(arr[0].method).toBe('extension');
    expect(arr[0].ncryptsec).toBeUndefined();
    expect(arr[0].nip46).toBeUndefined();
    expect(arr[0].androidPackageName).toBeUndefined();
  });

  it('hydrates an extension account but starts locked; re-login restores the signer', async () => {
    const sk = generateSecretKey();
    g.nostr = makeMockWindowNostr(sk);
    const storage = makeMockStorage();

    const first = createSigner({ storage });
    await first.loginWithExtension();
    const npub = first.getActiveAccount()!.npub;

    const second = createSigner({ storage });
    expect(second.listAccounts()).toHaveLength(1);
    expect(second.getActiveAccount()?.npub).toBe(npub);
    expect(second.getActiveSigner()).toBeNull();

    await second.loginWithExtension();
    expect(second.getActiveSigner()).not.toBeNull();
  });
});
