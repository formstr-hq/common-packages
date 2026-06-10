import { describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, nip19, verifyEvent } from 'nostr-tools';
import {
  createSigner,
  loginWithAndroidSigner,
  type AndroidSignerPlugin,
  type SignerEvent,
} from '../src/index.js';
import { LocalSigner } from '../src/core/localSigner.js';
import type { StorageAdapter } from '../src/core/storage.js';
import { MockAndroidPlugin } from './helpers/mockAndroidPlugin.js';

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

describe('NIP-55 (Android external signer)', () => {
  it('throws when no plugin is configured', async () => {
    const s = createSigner({ storage: makeMockStorage() });
    await expect(s.loginWithAndroidSigner()).rejects.toThrow(/no Android signer plugin/);
  });

  it('uses the plugin passed via SignerConfig by default', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const s = createSigner({
      storage: makeMockStorage(),
      androidSignerPlugin: plugin,
    });

    const account = await s.loginWithAndroidSigner();
    expect(account.method).toBe('android');
    expect(account.pubkey).toBe(getPublicKey(sk));
    expect(account.androidPackageName).toBe('com.mock.signer');
  });

  it('per-call plugin overrides the SignerConfig default', async () => {
    const sk1 = generateSecretKey();
    const sk2 = generateSecretKey();
    const configPlugin = new MockAndroidPlugin(sk1);
    const callPlugin = new MockAndroidPlugin(sk2);
    const s = createSigner({
      storage: makeMockStorage(),
      androidSignerPlugin: configPlugin,
    });

    const account = await s.loginWithAndroidSigner({ plugin: callPlugin });
    expect(account.pubkey).toBe(getPublicKey(sk2));
  });

  it('passes packageName to the plugin and stores it on the account', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: plugin });

    const account = await s.loginWithAndroidSigner({
      packageName: 'com.greenart7c3.nostrsigner',
    });
    expect(plugin.packageName).toBe('com.greenart7c3.nostrsigner');
    expect(account.androidPackageName).toBe('com.greenart7c3.nostrsigner');
  });

  it('signs events via the plugin and the signature verifies', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: plugin });
    await s.loginWithAndroidSigner();

    const signed = await s.getActiveSigner()!.signEvent({
      kind: 1,
      content: 'gm android',
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    expect(signed.pubkey).toBe(getPublicKey(sk));
    expect(verifyEvent(signed)).toBe(true);
  });

  it('round-trips nip04 and nip44 via the plugin', async () => {
    const skUser = generateSecretKey();
    const skPeer = generateSecretKey();
    const plugin = new MockAndroidPlugin(skUser);
    const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: plugin });
    await s.loginWithAndroidSigner();

    const active = s.getActiveSigner()!;
    const peer = new LocalSigner(skPeer);
    const userPubkey = getPublicKey(skUser);
    const peerPubkey = getPublicKey(skPeer);

    const ct44 = await active.nip44Encrypt(peerPubkey, 'via android 44');
    expect(await peer.nip44Decrypt(userPubkey, ct44)).toBe('via android 44');
    const peer44 = await peer.nip44Encrypt(userPubkey, 'back to android 44');
    expect(await active.nip44Decrypt(peerPubkey, peer44)).toBe('back to android 44');

    const ct04 = await active.nip04Encrypt(peerPubkey, 'via android 04');
    expect(await peer.nip04Decrypt(userPubkey, ct04)).toBe('via android 04');
    const peer04 = await peer.nip04Encrypt(userPubkey, 'back to android 04');
    expect(await active.nip04Decrypt(peerPubkey, peer04)).toBe('back to android 04');
  });

  it('exposes a stable pubkey via getPublicKey()', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: plugin });
    await s.loginWithAndroidSigner();
    expect(await s.getActiveSigner()!.getPublicKey()).toBe(getPublicKey(sk));
  });

  it('persists method:android and the package name but no key material', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const storage = makeMockStorage();
    const s = createSigner({ storage, androidSignerPlugin: plugin });
    await s.loginWithAndroidSigner({ packageName: 'com.greenart7c3.nostrsigner' });

    const arr = JSON.parse(storage.dump()['accounts']!);
    expect(arr).toHaveLength(1);
    expect(arr[0].method).toBe('android');
    expect(arr[0].androidPackageName).toBe('com.greenart7c3.nostrsigner');
    expect(arr[0].ncryptsec).toBeUndefined();
    expect(arr[0].nip46).toBeUndefined();

    const skHex = Array.from(sk)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const all = Object.values(storage.dump()).join('|');
    expect(all).not.toContain(skHex);
  });

  it('hydrates as locked; re-login restores the active signer', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const storage = makeMockStorage();

    const first = createSigner({ storage, androidSignerPlugin: plugin });
    await first.loginWithAndroidSigner();
    const npub = first.getActiveAccount()!.npub;

    const second = createSigner({ storage, androidSignerPlugin: plugin });
    expect(second.listAccounts()).toHaveLength(1);
    expect(second.getActiveAccount()?.npub).toBe(npub);
    expect(second.getActiveSigner()).toBeNull();

    await second.loginWithAndroidSigner();
    expect(second.getActiveSigner()).not.toBeNull();
  });

  it('rejects with the decoded type when the plugin returns a non-npub bech32 identifier', async () => {
    const fakeNsec = nip19.nsecEncode(generateSecretKey());
    const badPlugin = {
      setPackageName: async () => undefined,
      getInstalledSignerApps: async () => ({ apps: [] }),
      getPublicKey: async () => ({ npub: fakeNsec, package: 'com.fake.signer' }),
      signEvent: async (_p: string, _e: string, id: string) => ({ signature: '', id, event: '' }),
      nip04Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip04Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
    };
    await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(/non-npub/);
    // The error must call out which type was returned and preview the
    // value, so a caller looking at the message can immediately tell e.g.
    // nsec from nprofile. The nsec1 prefix is intentionally included —
    // exposing the first 12 chars of a bech32 string does not leak the
    // secret payload (the data section starts after the HRP + separator).
    await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(/type=nsec/);
    await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(/nsec1/);
  });

  it('rejects with a debuggable preview when the plugin returns an undecodable identifier', async () => {
    // Mirrors the real-world Amber regression: the plugin resolves with
    // an empty/near-empty string in the npub slot. nip19.decode chokes
    // ("Data must be at least 6 characters long"), and the package's
    // error must surface both the underlying cause and what was received.
    const badPlugin = {
      setPackageName: async () => undefined,
      getInstalledSignerApps: async () => ({ apps: [] }),
      getPublicKey: async () => ({ npub: '', package: 'com.fake.signer' }),
      signEvent: async (_p: string, _e: string, id: string) => ({ signature: '', id, event: '' }),
      nip04Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip04Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
    };
    await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(/undecodable identifier/);
    await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(/empty string/);
  });

  it('preview labels null / undefined / non-string identifiers distinctly', async () => {
    // Exhaustive shape coverage for the helper — a Capacitor plugin
    // shouldn't normally return null/undefined/number here, but if it
    // ever does we want the error message to say so plainly rather than
    // crash on `value.slice(...)`.
    const cases: Array<{ npub: unknown; match: RegExp }> = [
      { npub: null, match: /got null/ },
      { npub: undefined, match: /got undefined/ },
      { npub: 42 as unknown, match: /<number>/ },
      { npub: 'short', match: /"short"/ },
    ];
    for (const { npub, match } of cases) {
      const badPlugin = {
        setPackageName: async () => undefined,
        getInstalledSignerApps: async () => ({ apps: [] }),
        getPublicKey: async () => ({ npub: npub as string, package: 'com.fake.signer' }),
        signEvent: async (_p: string, _e: string, id: string) => ({ signature: '', id, event: '' }),
        nip04Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
        nip04Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
        nip44Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
        nip44Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      };
      await expect(loginWithAndroidSigner(badPlugin)).rejects.toThrow(match);
    }
  });

  it('rejects when neither plugin nor caller supplies a package name', async () => {
    const sk = generateSecretKey();
    const npub = nip19.npubEncode(getPublicKey(sk));
    const minimalPlugin = {
      setPackageName: async () => undefined,
      getInstalledSignerApps: async () => ({ apps: [] }),
      // No `package` field in the response, and we won't pass packageName.
      getPublicKey: async () => ({ npub, package: '' }),
      signEvent: async (_p: string, _e: string, id: string) => ({ signature: '', id, event: '' }),
      nip04Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip04Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Encrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
      nip44Decrypt: async (_p: string, _t: string, id: string) => ({ result: '', id }),
    };
    await expect(loginWithAndroidSigner(minimalPlugin)).rejects.toThrow(/package name/);

    const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: minimalPlugin });
    await expect(s.loginWithAndroidSigner()).rejects.toThrow(/package name/);
  });

  it('accepts a raw hex pubkey from the plugin (Amber compatibility)', async () => {
    // Real-world Amber regression: the plugin resolves with the 32-byte
    // hex pubkey in the `npub` slot instead of a bech32 `npub1…` string.
    // We must accept it and encode locally; otherwise legitimate sign-in
    // attempts crash with a bech32 "Data must be at least 6 characters"
    // error even though the user approved in Amber.
    const sk = generateSecretKey();
    const hexPubkey = getPublicKey(sk);
    const expectedNpub = nip19.npubEncode(hexPubkey);
    const amberLikePlugin: AndroidSignerPlugin = {
      setPackageName: async () => undefined,
      getInstalledSignerApps: async () => ({ apps: [] }),
      getPublicKey: async () => ({ npub: hexPubkey, package: 'com.greenart7c3.nostrsigner' }),
      signEvent: async (_p, _e, id) => ({ signature: '', id, event: '' }),
      nip04Encrypt: async (_p, _t, id) => ({ result: '', id }),
      nip04Decrypt: async (_p, _t, id) => ({ result: '', id }),
      nip44Encrypt: async (_p, _t, id) => ({ result: '', id }),
      nip44Decrypt: async (_p, _t, id) => ({ result: '', id }),
    };
    const result = await loginWithAndroidSigner(amberLikePlugin);
    expect(result.pubkey).toBe(hexPubkey);
    expect(result.npub).toBe(expectedNpub);
    expect(result.packageName).toBe('com.greenart7c3.nostrsigner');
  });

  it('lowercases a mixed-case hex pubkey before encoding', async () => {
    // Defense in depth — accept a hex string regardless of casing and
    // normalize, so downstream code never sees both forms for one identity.
    const sk = generateSecretKey();
    const hexPubkey = getPublicKey(sk);
    const mixedCase = hexPubkey
      .split('')
      .map((c, i) => (i % 2 === 0 ? c.toUpperCase() : c))
      .join('');
    const amberLikePlugin: AndroidSignerPlugin = {
      setPackageName: async () => undefined,
      getInstalledSignerApps: async () => ({ apps: [] }),
      getPublicKey: async () => ({ npub: mixedCase, package: 'com.fake.signer' }),
      signEvent: async (_p, _e, id) => ({ signature: '', id, event: '' }),
      nip04Encrypt: async (_p, _t, id) => ({ result: '', id }),
      nip04Decrypt: async (_p, _t, id) => ({ result: '', id }),
      nip44Encrypt: async (_p, _t, id) => ({ result: '', id }),
      nip44Decrypt: async (_p, _t, id) => ({ result: '', id }),
    };
    const result = await loginWithAndroidSigner(amberLikePlugin);
    expect(result.pubkey).toBe(hexPubkey); // lowercased
    expect(result.npub).toBe(nip19.npubEncode(hexPubkey));
  });

  it('loginWithAndroidSigner can be called directly (lower-level API)', async () => {
    const sk = generateSecretKey();
    const plugin = new MockAndroidPlugin(sk);
    const result = await loginWithAndroidSigner(plugin, 'com.test.app');
    expect(result.npub).toBe(nip19.npubEncode(getPublicKey(sk)));
    expect(result.pubkey).toBe(getPublicKey(sk));
    expect(result.packageName).toBe('com.test.app');
  });

  describe('unlock (silent hydrate, android branch)', () => {
    it('constructs the AndroidSigner from cached state with no plugin roundtrip', async () => {
      const sk = generateSecretKey();
      const plugin = new MockAndroidPlugin(sk);
      const storage = makeMockStorage();

      const first = createSigner({ storage, androidSignerPlugin: plugin });
      await first.loginWithAndroidSigner({ packageName: 'com.greenart7c3.nostrsigner' });

      const second = createSigner({ storage, androidSignerPlugin: plugin });
      expect(second.getActiveSigner()).toBeNull();

      // Spy on every plugin entry point that would cause an Amber prompt
      // on cold start. None of them must be invoked by unlock.
      const getPk = vi.spyOn(plugin, 'getPublicKey');
      const setPkg = vi.spyOn(plugin, 'setPackageName');

      const unlocked = await second.unlock();
      expect(unlocked).not.toBeNull();
      expect(getPk).not.toHaveBeenCalled();
      expect(setPkg).not.toHaveBeenCalled();
      expect(second.getActiveSigner()).toBe(unlocked);
      expect(await unlocked!.getPublicKey()).toBe(getPublicKey(sk));
    });

    it('returns null when active account is android but no plugin is configured', async () => {
      const sk = generateSecretKey();
      const plugin = new MockAndroidPlugin(sk);
      const storage = makeMockStorage();

      const first = createSigner({ storage, androidSignerPlugin: plugin });
      await first.loginWithAndroidSigner();

      // No androidSignerPlugin on the second instance.
      const second = createSigner({ storage });
      expect(await second.unlock()).toBeNull();
      expect(second.getActiveSigner()).toBeNull();
    });

    it('returns null when the active android account is missing androidPackageName', async () => {
      const sk = generateSecretKey();
      const pubkey = getPublicKey(sk);
      const npub = nip19.npubEncode(pubkey);
      const storage = makeMockStorage();
      storage.set(
        'accounts',
        // Deliberately malformed: method=android with no androidPackageName.
        // Shouldn't crash, just refuse to unlock.
        JSON.stringify([{ npub, pubkey, method: 'android' }]),
      );
      storage.set('active-pubkey', pubkey);
      const s = createSigner({
        storage,
        androidSignerPlugin: new MockAndroidPlugin(sk),
      });
      expect(await s.unlock()).toBeNull();
      expect(s.getActiveSigner()).toBeNull();
    });

    it('emits a login event when unlocking after fresh hydrate', async () => {
      const sk = generateSecretKey();
      const plugin = new MockAndroidPlugin(sk);
      const storage = makeMockStorage();

      const first = createSigner({ storage, androidSignerPlugin: plugin });
      await first.loginWithAndroidSigner();

      const second = createSigner({ storage, androidSignerPlugin: plugin });
      const events: SignerEvent[] = [];
      second.onChange((e) => events.push(e));
      await second.unlock();
      expect(events.map((e) => e.type)).toEqual(['login']);
    });

    it('unlocked signer signs valid events and round-trips nip44', async () => {
      const sk = generateSecretKey();
      const skPeer = generateSecretKey();
      const plugin = new MockAndroidPlugin(sk);
      const storage = makeMockStorage();

      const first = createSigner({ storage, androidSignerPlugin: plugin });
      await first.loginWithAndroidSigner();

      const second = createSigner({ storage, androidSignerPlugin: plugin });
      const unlocked = (await second.unlock())!;
      const peer = new LocalSigner(skPeer);
      const userPubkey = getPublicKey(sk);
      const peerPubkey = getPublicKey(skPeer);

      const signed = await unlocked.signEvent({
        kind: 1,
        content: 'unlocked',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      expect(verifyEvent(signed)).toBe(true);

      const ct = await unlocked.nip44Encrypt(peerPubkey, 'hello');
      expect(await peer.nip44Decrypt(userPubkey, ct)).toBe('hello');
    });
  });

  describe('listAndroidSignerApps', () => {
    it('returns the apps reported by the configured plugin', async () => {
      const sk = generateSecretKey();
      const plugin = new MockAndroidPlugin(sk, 'com.greenart7c3.nostrsigner');
      const s = createSigner({ storage: makeMockStorage(), androidSignerPlugin: plugin });
      const apps = await s.listAndroidSignerApps();
      expect(apps).toEqual([
        { name: 'Mock Signer', packageName: 'com.greenart7c3.nostrsigner' },
      ]);
    });

    it('throws when no plugin is configured', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await expect(s.listAndroidSignerApps()).rejects.toThrow(/no Android signer plugin/);
    });

    it('per-call plugin overrides the configured default', async () => {
      const skDefault = generateSecretKey();
      const skOverride = generateSecretKey();
      const defaultPlugin = new MockAndroidPlugin(skDefault, 'com.default.signer');
      const overridePlugin = new MockAndroidPlugin(skOverride, 'com.override.signer');
      const s = createSigner({
        storage: makeMockStorage(),
        androidSignerPlugin: defaultPlugin,
      });
      const apps = await s.listAndroidSignerApps(overridePlugin);
      expect(apps).toEqual([
        { name: 'Mock Signer', packageName: 'com.override.signer' },
      ]);
    });
  });
});
