import { describe, expect, it } from 'vitest';
import { verifyEvent, type Event } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { createIdentity, createNip98Event, signNip98 } from '../src/index.js';

const URL_ = 'https://api.formstr.app/api/generate-invoice/mail';
const BODY = '{"pubkey":"abc","nip05":"irona@mailstr.app","tierId":"base"}';

function sha256Hex(s: string): Promise<string> {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(s))
    .then((d) => bytesToHex(new Uint8Array(d)));
}

describe('NIP-98 auth headers', () => {
  it('creates a verifiable kind-27235 event with u/method tags and no payload', async () => {
    const { secretKey } = createIdentity();
    const ev = await createNip98Event(secretKey, URL_, 'post');
    expect(ev.kind).toBe(27235);
    expect(ev.content).toBe('');
    expect(ev.tags).toContainEqual(['u', URL_]);
    expect(ev.tags).toContainEqual(['method', 'POST']);
    expect(ev.tags.find((t) => t[0] === 'payload')).toBeUndefined();
    expect(verifyEvent(ev)).toBe(true);
  });

  it('includes a payload tag with the sha256 of the body', async () => {
    const { secretKey } = createIdentity();
    const ev = await createNip98Event(secretKey, URL_, 'POST', BODY);
    expect(ev.tags.find((t) => t[0] === 'payload')?.[1]).toBe(await sha256Hex(BODY));
  });

  it('signNip98 builds a "Nostr <base64(json)>" header that decodes to the event', async () => {
    const { secretKey } = createIdentity();
    const header = await signNip98(secretKey, URL_, 'POST', BODY);
    expect(header.startsWith('Nostr ')).toBe(true);
    const decoded = JSON.parse(atob(header.slice('Nostr '.length))) as Event;
    expect(verifyEvent(decoded)).toBe(true);
    expect(decoded.kind).toBe(27235);
    expect(decoded.tags).toContainEqual(['u', URL_]);
    expect(decoded.tags).toContainEqual(['method', 'POST']);
    expect(decoded.tags.find((t) => t[0] === 'payload')?.[1]).toBe(await sha256Hex(BODY));
  });

  it('uppercase-normalizes the method and omits payload without a body', async () => {
    const { secretKey } = createIdentity();
    const header = await signNip98(secretKey, URL_, 'get');
    const decoded = JSON.parse(atob(header.slice(6)));
    expect(decoded.tags).toEqual([
      ['u', URL_],
      ['method', 'GET'],
    ]);
  });
});