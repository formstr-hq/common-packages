import { describe, expect, it } from 'vitest';
import { getEventHash } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';
import { unwrapMail, WRAP_KEY_TAG } from '../src/index.js';
import type { Rumor } from '../src/types.js';
import { makeKeypair, wrapSeal, wrapChain, sealRumor, makeRumor } from './helpers/synthetic.js';

// Real current time: fresh rumors are created_at ≈ now, so only tests that
// explicitly build older rumors hit the staleness rule.
const NOW = Math.floor(Date.now() / 1000);

/** Keys for the standard scenario: a recipient reading mail from a sender. */
function scenario() {
  const recipient = makeKeypair();
  const sender = makeKeypair();
  return { recipient, sender };
}

describe('unwrapMail — valid wraps', () => {
  it('unwraps wrap → seal → rumor and reports both events', () => {
    const { recipient, sender } = scenario();
    const { wrap, seal, rumor } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: 'hello mail' },
      { recipientSk: recipient.secretKey },
    );
    const result = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.seal.id).toBe(seal.id);
      expect(result.rumor).toEqual(rumor);
      expect(result.wrapSecret).toBeUndefined();
    }
  });

  it('passes the embedded wrap key through when it matches the wrap author', () => {
    const { recipient, sender } = scenario();
    const wrapSk = makeKeypair();
    const { wrap } = wrapChain(
      {
        senderSk: sender.secretKey,
        recipientPk: recipient.pubkey,
        extraTags: [[WRAP_KEY_TAG, bytesToHex(wrapSk.secretKey)]],
      },
      { recipientSk: recipient.secretKey, wrapSk: wrapSk.secretKey },
    );
    const result = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(result).toMatchObject({ ok: true, wrapSecret: bytesToHex(wrapSk.secretKey) });
  });
});

describe('unwrapMail — failures', () => {
  it('not-for-us: wrap encrypted to a different key', () => {
    const { recipient, sender } = scenario();
    const stranger = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: stranger.pubkey },
      { recipientSk: stranger.secretKey },
    );
    expect(unwrapMail(wrap, recipient.secretKey, { now: NOW })).toEqual({
      ok: false,
      reason: 'not-for-us',
    });
  });

  it('malformed-seal: wrap payload is not JSON', () => {
    const { recipient } = scenario();
    const wrap = wrapSeal(
      { id: '', pubkey: '', created_at: 0, kind: 0, tags: [], content: '', sig: '' } as never,
      recipient.pubkey,
      makeKeypair().secretKey,
      { content: 'hello' },
    );
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-seal');
  });

  it('malformed-seal: wrap payload parses to a non-object', () => {
    const { recipient } = scenario();
    const wrap = wrapSeal({} as never, recipient.pubkey, makeKeypair().secretKey, {
      content: '5',
    });
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-seal');
  });

  it('malformed-seal: seal lacks kind/pubkey (checked before signature)', () => {
    const { recipient } = scenario();
    const wrap = wrapSeal({} as never, recipient.pubkey, makeKeypair().secretKey, {
      content: JSON.stringify({ nostr: 'not really' }),
    });
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-seal');
  });

  it('bad-seal-signature: flipped sig byte', () => {
    const { recipient, sender } = scenario();
    const { seal } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey },
      { recipientSk: recipient.secretKey },
    );
    seal.sig = (seal.sig[0] === '0' ? '1' : '0') + seal.sig.slice(1);
    const tampered = wrapSeal(seal, recipient.pubkey, makeKeypair().secretKey);
    const r = unwrapMail(tampered, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad-seal-signature');
  });

  it('wrong-seal-kind: sealed with another kind', () => {
    const { recipient, sender } = scenario();
    const rumor = makeRumor({ senderSk: sender.secretKey, recipientPk: recipient.pubkey });
    const seal = sealRumor(rumor, sender.secretKey, recipient.pubkey, { kind: 14 });
    const wrap = wrapSeal(seal, recipient.pubkey, makeKeypair().secretKey);
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-seal-kind');
  });

  it('malformed-rumor: seal payload is not JSON', () => {
    const { recipient, sender } = scenario();
    const rumor = makeRumor({ senderSk: sender.secretKey, recipientPk: recipient.pubkey });
    const seal = sealRumor(rumor, sender.secretKey, recipient.pubkey, { content: 'not json' });
    const wrap = wrapSeal(seal, recipient.pubkey, makeKeypair().secretKey);
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-rumor');
  });

  it('malformed-rumor: rumor missing the tags array fails the shape check', () => {
    const { recipient, sender } = scenario();
    const broken = {
      kind: 1301,
      pubkey: sender.pubkey,
      created_at: NOW,
      content: 'x',
      id: getEventHash({
        kind: 1301,
        pubkey: sender.pubkey,
        created_at: NOW,
        content: 'x',
        tags: [],
      }),
    };
    const seal = sealRumor(broken as unknown as Rumor, sender.secretKey, recipient.pubkey);
    const wrap = wrapSeal(seal, recipient.pubkey, makeKeypair().secretKey);
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('malformed-rumor');
  });

  it('author-mismatch: rumor author differs from seal author (the spoof check)', () => {
    const { recipient, sender } = scenario();
    const impostor = makeKeypair();
    const base = makeRumor({ senderSk: sender.secretKey, recipientPk: recipient.pubkey });
    const spoofed = { ...base, pubkey: impostor.pubkey, id: getEventHash({ ...base, pubkey: impostor.pubkey }) };
    const seal = sealRumor(spoofed, sender.secretKey, recipient.pubkey);
    const wrap = wrapSeal(seal, recipient.pubkey, makeKeypair().secretKey);
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('author-mismatch');
  });

  it('wrong-rumor-kind: NIP-17 DMs rejected by default, accepted when widened', () => {
    const { recipient, sender } = scenario();
    const { wrap } = wrapChain(
      {
        senderSk: sender.secretKey,
        recipientPk: recipient.pubkey,
        kind: 14,
        content: '{"dm":true}',
      },
      { recipientSk: recipient.secretKey },
    );
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrong-rumor-kind');
    const widened = unwrapMail(wrap, recipient.secretKey, { now: NOW, acceptKinds: [1301, 14] });
    expect(widened.ok).toBe(true);
  });

  it('expired: rumor older than MAX_RUMOR_AGE_SECONDS (300), tunable via options', () => {
    const { recipient, sender } = scenario();
    const birth = NOW - 301;
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, createdAt: birth },
      { recipientSk: recipient.secretKey },
    );
    expect(unwrapMail(wrap, recipient.secretKey, { now: NOW })).toEqual({
      ok: false,
      reason: 'expired',
    });
    // Exactly at the limit → still valid; the check is `>` not `>=`.
    expect(unwrapMail(wrap, recipient.secretKey, { now: birth + 300 }).ok).toBe(true);
    // A caller may relax the default (e.g. inbox archaeology).
    expect(unwrapMail(wrap, recipient.secretKey, { now: NOW, maxAgeSeconds: 400 }).ok).toBe(true);
  });

  it('wrapkey-mismatch: embedded key derives to a different wrap author', () => {
    const { recipient, sender } = scenario();
    const attackerSk = makeKeypair(); // actual wrap author
    const claimed = makeKeypair(); // key the rumor claims
    const lie = makeRumor({
      senderSk: sender.secretKey,
      recipientPk: recipient.pubkey,
      extraTags: [[WRAP_KEY_TAG, bytesToHex(claimed.secretKey)]],
    });
    const seal = sealRumor(lie, sender.secretKey, recipient.pubkey);
    const wrap = wrapSeal(seal, recipient.pubkey, attackerSk.secretKey);
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrapkey-mismatch');
  });

  it('wrapkey-mismatch: non-hex embedded key rejected', () => {
    const { recipient, sender } = scenario();
    const { wrap } = wrapChain(
      {
        senderSk: sender.secretKey,
        recipientPk: recipient.pubkey,
        extraTags: [[WRAP_KEY_TAG, 'zz-not-hex']],
      },
      { recipientSk: recipient.secretKey },
    );
    const r = unwrapMail(wrap, recipient.secretKey, { now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('wrapkey-mismatch');
  });
});