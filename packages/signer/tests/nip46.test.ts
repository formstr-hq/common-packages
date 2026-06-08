import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools';
import { LocalSigner } from '../src/core/localSigner.js';
import {
  BunkerSigner,
  createSigner,
  hexToBytes,
  bytesToHex,
  initiateNostrConnect,
} from '../src/index.js';
import type { StorageAdapter } from '../src/core/storage.js';
import { MockPool } from './helpers/mockRelay.js';
import { MockBunker } from './helpers/mockBunker.js';

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

const RELAY = 'wss://mock.test/';

describe('NIP-46 (bunker URI flow)', () => {
  it('rejects bunker URIs that lack a relay', async () => {
    const pool = new MockPool();
    const s = createSigner({ storage: makeMockStorage() });
    await expect(
      s.loginWithBunkerUri(`bunker://${'00'.repeat(32)}`, { pool: pool.asPool() }),
    ).rejects.toThrow(/at least one relay/);
  });

  it('rejects malformed bunker URIs', async () => {
    const pool = new MockPool();
    const s = createSigner({ storage: makeMockStorage() });
    await expect(
      s.loginWithBunkerUri('not-a-bunker-uri', { pool: pool.asPool() }),
    ).rejects.toThrow(/invalid bunker URI/);
  });

  it('connects, retrieves the user pubkey, and signs verifiable events', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });

    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
    });

    expect(account.method).toBe('nip46');
    expect(account.pubkey).toBe(getPublicKey(userSecretKey));
    expect(account.nip46?.remoteSignerPubkey).toBe(bunker.bunkerPubkey);
    expect(account.nip46?.relays).toEqual([RELAY]);
    expect(account.ncryptsec).toBeUndefined();

    const signed = await s.getActiveSigner()!.signEvent({
      kind: 1,
      content: 'gm from bunker',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(signed.pubkey).toBe(getPublicKey(userSecretKey));
    expect(verifyEvent(signed)).toBe(true);
  });

  it('round-trips nip44 in both directions between the bunker-backed signer and a peer', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });

    const peerSecretKey = generateSecretKey();
    const peerPubkey = getPublicKey(peerSecretKey);
    const peer = new LocalSigner(peerSecretKey);
    const active = s.getActiveSigner()!;
    const userPubkey = getPublicKey(userSecretKey);

    const fromBunker = await active.nip44Encrypt(peerPubkey, 'hi peer');
    expect(await peer.nip44Decrypt(userPubkey, fromBunker)).toBe('hi peer');

    const fromPeer = await peer.nip44Encrypt(userPubkey, 'hi user');
    expect(await active.nip44Decrypt(peerPubkey, fromPeer)).toBe('hi user');
  });

  it('round-trips nip04 in both directions between the bunker-backed signer and a peer', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });

    const peerSecretKey = generateSecretKey();
    const peerPubkey = getPublicKey(peerSecretKey);
    const peer = new LocalSigner(peerSecretKey);
    const active = s.getActiveSigner()!;
    const userPubkey = getPublicKey(userSecretKey);

    const fromBunker = await active.nip04Encrypt(peerPubkey, 'hi peer');
    expect(await peer.nip04Decrypt(userPubkey, fromBunker)).toBe('hi peer');

    const fromPeer = await peer.nip04Encrypt(userPubkey, 'hi user');
    expect(await active.nip04Decrypt(peerPubkey, fromPeer)).toBe('hi user');
  });

  it('BunkerSigner.close() delegates to the underlying signer', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });
    const active = s.getActiveSigner() as BunkerSigner;
    await expect(active.close()).resolves.toBeUndefined();
  });

  it('BunkerSigner.getPublicKey() delegates to the underlying signer', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });
    await s.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });
    expect(await s.getActiveSigner()!.getPublicKey()).toBe(getPublicKey(userSecretKey));
  });

  it('persists nip46 metadata and never leaks the user secret', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const storage = makeMockStorage();
    const s = createSigner({ storage });
    await s.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });

    const arr = JSON.parse(storage.dump()['accounts']!);
    expect(arr).toHaveLength(1);
    expect(arr[0].method).toBe('nip46');
    expect(arr[0].nip46.remoteSignerPubkey).toBe(bunker.bunkerPubkey);
    expect(arr[0].nip46.relays).toEqual([RELAY]);
    expect(arr[0].nip46.clientSecretKey).toMatch(/^[0-9a-f]{64}$/);

    const userHex = Array.from(userSecretKey)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const all = Object.values(storage.dump()).join('|');
    expect(all).not.toContain(userHex);
  });

  it('re-establishes the bunker session using the stored clientSecretKey', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const storage = makeMockStorage();

    const first = createSigner({ storage });
    await first.loginWithBunkerUri(bunker.buildBunkerUri(), { pool: pool.asPool() });
    const storedClientSecretHex = first.getActiveAccount()!.nip46!.clientSecretKey;

    const second = createSigner({ storage });
    expect(second.getActiveSigner()).toBeNull();
    await second.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      clientSecretKey: hexToBytes(storedClientSecretHex),
    });
    expect(second.getActiveSigner()).not.toBeNull();
    expect(second.getActiveAccount()!.nip46!.clientSecretKey).toBe(storedClientSecretHex);
  });
});

describe('NIP-46 hex helpers', () => {
  it('bytesToHex / hexToBytes round-trip', () => {
    const original = new Uint8Array([0x00, 0x0f, 0xab, 0xff]);
    expect(bytesToHex(original)).toBe('000fabff');
    expect(hexToBytes('000fabff')).toEqual(original);
  });

  it('hexToBytes rejects odd-length input', () => {
    expect(() => hexToBytes('abc')).toThrow(/odd-length/);
  });
});

describe('NIP-46 initiateNostrConnect direct usage', () => {
  it('rejects when no relays are provided', () => {
    expect(() => initiateNostrConnect({ relays: [] })).toThrow(/at least one relay/);
  });
});

describe('NIP-46 relay mismatch detection (bunker URI flow)', () => {
  const OTHER = 'wss://other.test/';

  it('does not invoke onRelayMismatch when the bunker prefers the same list', async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({ pool, relays: [RELAY], preferredRelays: [RELAY] });
    const s = createSigner({ storage: makeMockStorage() });
    const onRelayMismatch = vi.fn();

    await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch,
    });

    expect(onRelayMismatch).not.toHaveBeenCalled();
  });

  it('invokes onRelayMismatch with both lists when they differ', async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      preferredRelays: [RELAY, OTHER],
    });
    const s = createSigner({ storage: makeMockStorage() });
    const onRelayMismatch = vi.fn().mockResolvedValue(false);

    await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch,
    });

    expect(onRelayMismatch).toHaveBeenCalledTimes(1);
    const info = onRelayMismatch.mock.calls[0][0];
    expect(info.userRelays).toEqual([RELAY]);
    expect(info.bunkerRelays.sort()).toEqual([OTHER, RELAY].sort());
  });

  it('keeps user-supplied relays when the callback declines', async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      preferredRelays: [OTHER],
    });
    const s = createSigner({ storage: makeMockStorage() });

    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch: () => false,
    });

    expect(account.nip46?.relays).toEqual([RELAY]);
  });

  it('skips the callback when the bunker rejects get_relays', async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({ pool, relays: [RELAY], failGetRelays: true });
    const s = createSigner({ storage: makeMockStorage() });
    const onRelayMismatch = vi.fn().mockResolvedValue(true);

    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch,
    });

    expect(onRelayMismatch).not.toHaveBeenCalled();
    expect(account.nip46?.relays).toEqual([RELAY]);
  });

  it('handles an array-shaped get_relays response', async () => {
    const OTHER = 'wss://array.test/';
    const pool = new MockPool();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      getRelaysResultJson: JSON.stringify([OTHER]),
    });
    const s = createSigner({ storage: makeMockStorage() });
    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch: () => true,
    });
    expect(account.nip46?.relays).toEqual([OTHER]);
  });

  it('skips the callback when get_relays returns a non-array, non-object value', async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      getRelaysResultJson: '42',
    });
    const s = createSigner({ storage: makeMockStorage() });
    const onRelayMismatch = vi.fn();
    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch,
    });
    expect(onRelayMismatch).not.toHaveBeenCalled();
    expect(account.nip46?.relays).toEqual([RELAY]);
  });

  it("stores the bunker's relays when the callback accepts", async () => {
    const pool = new MockPool();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      preferredRelays: [OTHER],
    });
    const s = createSigner({ storage: makeMockStorage() });

    const account = await s.loginWithBunkerUri(bunker.buildBunkerUri(), {
      pool: pool.asPool(),
      onRelayMismatch: () => true,
    });

    expect(account.nip46?.relays).toEqual([OTHER]);
  });
});

describe('NIP-46 (nostrconnect QR flow)', () => {
  it('rejects when no relays are provided', async () => {
    const s = createSigner({ storage: makeMockStorage() });
    await expect(
      s.loginWithNostrConnect({
        relays: [],
        onUri: () => {},
      }),
    ).rejects.toThrow(/at least one relay/);
  });

  it('emits the nostrconnect URI synchronously and completes when the bunker pairs', async () => {
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({ pool, relays: [RELAY], userSecretKey });
    const s = createSigner({ storage: makeMockStorage() });
    const onUri = vi.fn();

    const loginPromise = s.loginWithNostrConnect({
      relays: [RELAY],
      onUri,
      pool: pool.asPool(),
      metadata: { name: 'tester' },
    });

    expect(onUri).toHaveBeenCalledTimes(1);
    const uri: string = onUri.mock.calls[0][0];
    expect(uri).toMatch(/^nostrconnect:\/\//);
    expect(uri).toContain(encodeURIComponent(RELAY));

    bunker.scanNostrConnectURI(uri);

    const account = await loginPromise;
    expect(account.method).toBe('nip46');
    expect(account.pubkey).toBe(getPublicKey(userSecretKey));
    expect(account.nip46?.remoteSignerPubkey).toBe(bunker.bunkerPubkey);
    expect(account.nip46?.relays).toEqual([RELAY]);

    const signed = await s.getActiveSigner()!.signEvent({
      kind: 1,
      content: 'gm post-nostrconnect',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(verifyEvent(signed)).toBe(true);
  });

  it('surfaces a bunker relay mismatch via onRelayMismatch', async () => {
    const OTHER = 'wss://other.test/';
    const pool = new MockPool();
    const userSecretKey = generateSecretKey();
    const bunker = new MockBunker({
      pool,
      relays: [RELAY],
      preferredRelays: [OTHER],
      userSecretKey,
    });
    const s = createSigner({ storage: makeMockStorage() });
    const onRelayMismatch = vi.fn().mockResolvedValue(true);

    const loginPromise = s.loginWithNostrConnect({
      relays: [RELAY],
      onUri: (uri) => bunker.scanNostrConnectURI(uri),
      pool: pool.asPool(),
      onRelayMismatch,
    });

    const account = await loginPromise;
    expect(onRelayMismatch).toHaveBeenCalledTimes(1);
    expect(account.nip46?.relays).toEqual([OTHER]);
  });

  it('times out when no bunker pairs within the timeout window', async () => {
    const pool = new MockPool();
    const s = createSigner({ storage: makeMockStorage() });
    await expect(
      s.loginWithNostrConnect({
        relays: [RELAY],
        onUri: () => {},
        pool: pool.asPool(),
        timeoutMs: 50,
      }),
    ).rejects.toThrow();
  });
});
