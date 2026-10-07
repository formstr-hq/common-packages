import { describe, expect, it, vi } from 'vitest';
import {
  createIdentity,
  defaultFromAddress,
  fetchOwnedAddressesWith,
  normalizeOwnedAddresses,
} from '../src/index.js';
import { makeMailSigner } from './helpers/synthetic.js';

describe('normalizeOwnedAddresses', () => {
  it('handles every plausible server shape and qualifies bare localparts', () => {
    expect(normalizeOwnedAddresses('abhay')).toEqual(['abhay@mailstr.app']);
    expect(normalizeOwnedAddresses(['abhay', 'me@x.com'])).toEqual(['abhay@mailstr.app', 'me@x.com']);
    expect(normalizeOwnedAddresses({ nip05Addresses: ['a', 'b'] })).toEqual([
      'a@mailstr.app',
      'b@mailstr.app',
    ]);
    expect(normalizeOwnedAddresses([{ nip05: 'abhay' }])).toEqual(['abhay@mailstr.app']);
    // A workspace alias carries its own domain — must not be re-qualified.
    expect(normalizeOwnedAddresses([{ nip05: 'alice', domain: 'acme.com' }])).toEqual(['alice@acme.com']);
    expect(normalizeOwnedAddresses([{ name: 'irona', domain: 'works.dev' }])).toEqual(['irona@works.dev']);
    // Unrecognized input is "no addresses", never a throw.
    expect(normalizeOwnedAddresses(null)).toEqual([]);
    expect(normalizeOwnedAddresses({})).toEqual([]);
  });
});

describe('fetchOwnedAddressesWith', () => {
  it('lists aliases via a NIP-98-signed GET', async () => {
    const id = createIdentity();
    const fetchJson = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      expect(url).toBe('https://api.formstr.app/api/nip-05/get-nip05');
      const decoded = JSON.parse(atob(init.headers.Authorization.slice('Nostr '.length)));
      expect(decoded.tags).toContainEqual(['method', 'GET']);
      expect(decoded.pubkey).toBe(id.pubkey);
      return { ok: true, status: 200, body: { nip05Addresses: ['irona', 'irona@works.dev'] } };
    });
    const out = await fetchOwnedAddressesWith(makeMailSigner(id.secretKey), { fetchJson });
    expect(out).toEqual(['irona@mailstr.app', 'irona@works.dev']);
    expect(fetchJson).toHaveBeenCalledOnce();
  });

  it('treats 404/401 as "no aliases" rather than an error', async () => {
    const id = createIdentity();
    for (const status of [404, 401]) {
      const out = await fetchOwnedAddressesWith(makeMailSigner(id.secretKey), {
        fetchJson: async () => ({ ok: false, status, body: null }),
      });
      expect(out).toEqual([]);
    }
  });
});

describe('defaultFromAddress', () => {
  it('prefers a registered alias over the npub mailbox', () => {
    const id = createIdentity();
    const npubAddr = defaultFromAddress(id.pubkey, []);
    expect(npubAddr).toBe(`${id.npub}@mailstr.app`);
    expect(defaultFromAddress(id.pubkey, ['irona@mailstr.app'])).toBe('irona@mailstr.app');
    expect(defaultFromAddress(id.pubkey, [`${id.npub}@mailstr.app`, 'irona@mailstr.app'])).toBe(
      'irona@mailstr.app',
    );
    // Only an npub mailbox available → use it.
    expect(defaultFromAddress(id.pubkey, [`${id.npub}@mailstr.app`])).toBe(`${id.npub}@mailstr.app`);
  });
});
