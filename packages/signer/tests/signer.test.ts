import { describe, expect, it, vi } from 'vitest';
import { createSigner, type SignerEvent } from '../src/index.js';
import type { StorageAdapter } from '../src/core/storage.js';
import { decryptNcryptsec } from '../src/nip49.js';

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

const toHex = (b: Uint8Array): string =>
  Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

const toBase64 = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
};

describe('Signer', () => {
  describe('createAccount', () => {
    it('throws when passphrase is empty', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await expect(s.createAccount('')).rejects.toThrow(/passphrase required/);
    });

    it('activates a fresh account and yields a usable signer', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const { npub } = await s.createAccount('hunter2');
      expect(s.getActiveAccount()?.npub).toBe(npub);
      const active = s.getActiveSigner();
      expect(active).not.toBeNull();
      const event = await active!.signEvent({
        kind: 1,
        content: 'gm',
        tags: [],
        created_at: 0,
      });
      expect(event.sig).toMatch(/^[a-f0-9]{128}$/);
    });
  });

  describe('persistence security invariants', () => {
    it('never persists the raw secret key in any form', async () => {
      const storage = makeMockStorage();
      const s = createSigner({ storage });
      const { ncryptsec } = await s.createAccount('hunter2');
      const sk = decryptNcryptsec(ncryptsec, 'hunter2');
      const allValues = Object.values(storage.dump()).join('|');
      expect(allValues).not.toContain(toHex(sk));
      expect(allValues).not.toContain(toBase64(sk));
    });

    it('persists only npub, pubkey, method, and ncryptsec fields', async () => {
      const storage = makeMockStorage();
      const s = createSigner({ storage });
      const { npub } = await s.createAccount('hunter2');
      const raw = storage.dump()['accounts'];
      expect(raw).toBeTruthy();
      const arr = JSON.parse(raw);
      expect(arr).toHaveLength(1);
      expect(arr[0].npub).toBe(npub);
      expect(arr[0].method).toBe('ncryptsec');
      expect(arr[0].ncryptsec).toMatch(/^ncryptsec1/);
      expect(arr[0].secretKey).toBeUndefined();
      expect(arr[0].privkey).toBeUndefined();
      expect(arr[0].nsec).toBeUndefined();
    });
  });

  describe('loginWithNcryptsec validation', () => {
    it('throws when ncryptsec is empty', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await expect(s.loginWithNcryptsec('', 'pass')).rejects.toThrow(/ncryptsec required/);
    });

    it('throws when passphrase is empty', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await expect(s.loginWithNcryptsec('ncryptsec1xxx', '')).rejects.toThrow(
        /passphrase required/,
      );
    });
  });

  describe('hydration / locked state', () => {
    it('re-hydrates the accounts list across instances but starts locked', async () => {
      const storage = makeMockStorage();
      const a = createSigner({ storage });
      await a.createAccount('hunter2');
      const npub = a.getActiveAccount()!.npub;

      const b = createSigner({ storage });
      expect(b.listAccounts()).toHaveLength(1);
      expect(b.getActiveAccount()?.npub).toBe(npub);
      expect(b.getActiveSigner()).toBeNull();
    });

    it('loginWithNcryptsec after hydration unlocks the signer', async () => {
      const storage = makeMockStorage();
      const a = createSigner({ storage });
      const { ncryptsec } = await a.createAccount('hunter2');

      const b = createSigner({ storage });
      expect(b.getActiveSigner()).toBeNull();
      await b.loginWithNcryptsec(ncryptsec, 'hunter2');
      expect(b.getActiveSigner()).not.toBeNull();
    });

    it('loginWithNcryptsec with the wrong passphrase throws and leaves state untouched', async () => {
      const storage = makeMockStorage();
      const a = createSigner({ storage });
      const { ncryptsec } = await a.createAccount('hunter2');
      const b = createSigner({ storage });
      await expect(b.loginWithNcryptsec(ncryptsec, 'wrong')).rejects.toThrow();
      expect(b.getActiveSigner()).toBeNull();
    });
  });

  describe('multi-account', () => {
    it('listAccounts returns every created account', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await s.createAccount('p1');
      await s.createAccount('p2');
      expect(s.listAccounts()).toHaveLength(2);
    });

    it('createAccount on a non-empty list emits switch, not login', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const events: SignerEvent[] = [];
      s.onChange((e) => events.push(e));
      await s.createAccount('p1');
      await s.createAccount('p2');
      expect(events.map((e) => e.type)).toEqual(['login', 'switch']);
    });

    it('switchAccount changes active and clears the in-memory signer', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await s.createAccount('p1');
      const firstPubkey = s.listAccounts()[0].pubkey;
      await s.createAccount('p2');
      expect(s.getActiveAccount()?.pubkey).not.toBe(firstPubkey);
      await s.switchAccount(firstPubkey);
      expect(s.getActiveAccount()?.pubkey).toBe(firstPubkey);
      expect(s.getActiveSigner()).toBeNull();
    });

    it('switchAccount with an unknown pubkey throws', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await expect(s.switchAccount('00'.repeat(32))).rejects.toThrow(/no account/);
    });

    it('logout removes the account and emits logout', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const events: SignerEvent[] = [];
      s.onChange((e) => events.push(e));
      await s.createAccount('p1');
      const pubkey = s.getActiveAccount()!.pubkey;
      await s.logout();
      expect(s.listAccounts()).toHaveLength(0);
      expect(s.getActiveAccount()).toBeNull();
      expect(s.getActiveSigner()).toBeNull();
      expect(events.at(-1)).toEqual({ type: 'logout', pubkey });
    });

    it('logout(pubkey) targets a specific non-active account', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      await s.createAccount('p1');
      const firstPubkey = s.listAccounts()[0].pubkey;
      await s.createAccount('p2');
      const secondPubkey = s.getActiveAccount()!.pubkey;
      await s.logout(firstPubkey);
      const remaining = s.listAccounts();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].pubkey).toBe(secondPubkey);
      expect(s.getActiveAccount()?.pubkey).toBe(secondPubkey);
    });
  });

  describe('onChange', () => {
    it('unsubscribe stops further callbacks', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const cb = vi.fn();
      const unsub = s.onChange(cb);
      await s.createAccount('p1');
      expect(cb).toHaveBeenCalledTimes(1);
      unsub();
      await s.createAccount('p2');
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('a throwing listener does not break other listeners', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const good = vi.fn();
      s.onChange(() => {
        throw new Error('boom');
      });
      s.onChange(good);
      await s.createAccount('p1');
      expect(good).toHaveBeenCalledTimes(1);
    });
  });

  describe('hydration edge cases', () => {
    it('falls back to empty state when storage contents are corrupted', () => {
      const data = new Map<string, string>([
        ['accounts', '{not valid json'],
        ['active-pubkey', 'whatever'],
      ]);
      const storage: StorageAdapter = {
        get: (k) => data.get(k) ?? null,
        set: (k, v) => {
          data.set(k, v);
        },
        remove: (k) => {
          data.delete(k);
        },
      };
      const s = createSigner({ storage });
      expect(s.listAccounts()).toEqual([]);
      expect(s.getActiveAccount()).toBeNull();
    });

    it('returns null from getActiveAccount when activePubkey does not match any stored account', () => {
      const storage = makeMockStorage();
      storage.set('accounts', JSON.stringify([]));
      storage.set('active-pubkey', '00'.repeat(32));
      const s = createSigner({ storage });
      expect(s.getActiveAccount()).toBeNull();
    });

    it('ignores a non-array accounts payload', () => {
      const storage = makeMockStorage();
      storage.set('accounts', JSON.stringify({ not: 'an array' }));
      const s = createSigner({ storage });
      expect(s.listAccounts()).toEqual([]);
    });
  });

  describe('logout edge cases', () => {
    it('logout with no active account and no pubkey arg is a no-op', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      const cb = vi.fn();
      s.onChange(cb);
      await s.logout();
      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('config defaults', () => {
    it('falls back to the default localStorage adapter when no storage is provided', () => {
      // Just ensure construction works without a storage argument.
      // The default adapter is exercised separately in storage.test.ts.
      const s = createSigner();
      expect(s.listAccounts()).toEqual([]);
    });
  });
});
