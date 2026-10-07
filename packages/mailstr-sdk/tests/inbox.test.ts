import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimplePool, type Filter } from 'nostr-tools';
import { createIdentity, readInbox, readInboxWith } from '../src/index.js';
import { makeKeypair, wrapChain, makeMailSigner } from './helpers/synthetic.js';

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>();
  // Stand-in for the relay SimplePool: records the filter the SDK queried.
  const registry: { wraps: unknown[]; filter: Filter | undefined } = { wraps: [], filter: undefined };
  class FakePool {
    static registry = registry;
    querySync(_relays: string[], filter: Filter): Promise<unknown[]> {
      registry.filter = filter;
      return Promise.resolve(FakePool.registry.wraps);
    }
  }
  return { ...actual, SimplePool: FakePool };
});

const fakePool = SimplePool as unknown as {
  registry: { wraps: unknown[]; filter: Filter | undefined };
};

const RFC822 = [
  'From: Alice <alice@example.com>',
  'To: bob@example.test',
  'Subject: Weekly update',
  'Message-ID: <m1@example.com>',
  'Content-Type: text/plain; charset=us-ascii',
  '',
  'Hello Bob,',
  '',
  'This is the body.',
  '',
].join('\r\n');

// 'café' as a JS string: every code unit is already a single octet (0x63 0x61
// 0x66 0xE9) — exactly what §4's byte-string convention puts in rumor.content.
// UTF-8 encoding it (TextEncoder) would double-encode é as 0xC3 0xA9 and the
// ISO-8859-1 body would decode as "Ã©" — the bug bytes.ts exists to prevent.
const ISO_BODY = 'caf\u00e9';
const ISO822 = [
  'From: Cea <cea@example.com>',
  'To: bob@example.test',
  'Subject: charset test',
  'Content-Type: text/plain; charset=ISO-8859-1',
  '',
  ISO_BODY,
].join('\r\n');

beforeEach(() => {
  fakePool.registry.wraps = [];
  fakePool.registry.filter = undefined;
});

describe('readInbox', () => {
  it('queries kind-1059 wraps p-tagged to the reader via SimplePool by default', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    fakePool.registry.wraps = [wrap];
    const out = await readInbox(recipient.secretKey);
    expect(fakePool.registry.filter).toEqual({
      kinds: [1059],
      '#p': [recipient.pubkey],
      limit: 100,
    });
    expect(out.mail).toHaveLength(1);
    expect(out.failures).toHaveLength(0);
    expect(out.seenWrapIds).toEqual([wrap.id]);
  });

  it('deduplicates the same wrap seen on several relays', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    fakePool.registry.wraps = [wrap, wrap];
    const out = await readInbox(recipient.secretKey);
    expect(out.seenWrapIds).toHaveLength(1);
    expect(out.mail).toHaveLength(1);
  });

  it('parses RFC 2822 rumors through postal-mime', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { rumor, wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, {
      queryWraps: async () => [wrap],
    });
    const msg = out.mail[0];
    expect(msg.from).toBe('Alice <alice@example.com>');
    expect(msg.to).toBe('bob@example.test');
    expect(msg.subject).toBe('Weekly update');
    expect(msg.messageId).toContain('m1@example.com');
    expect(msg.text).toContain('This is the body.');
    expect(msg.raw).toBe(rumor.content);
    expect(msg.receivedAt).toBe(rumor.created_at);
    expect(msg.seal.pubkey).toBe(sender.pubkey);
  });

  it('honors ISO-8859-1 byte-string content (§4 fidelity)', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      {
        senderSk: sender.secretKey,
        recipientPk: recipient.pubkey,
        // The content string carries the ISO-8859-1 octets directly (§4).
        content: ISO822,
      },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, { queryWraps: async () => [wrap] });
    expect(out.mail[0].text).toContain('caf\u00e9');
  });

  it('falls back to the raw content when the parser throws', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: 'garbage' },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, {
      queryWraps: async () => [wrap],
      parse: async () => {
        throw new Error('boom');
      },
    });
    expect(out.mail[0].subject).toBe('(no subject)');
    expect(out.mail[0].text).toBe('garbage');
    expect(out.mail[0].from).toBe('?');
    expect(out.mail[0].messageId).toBe('');
  });

  it('reports placeholder fields for header-less content from real postal-mime', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: 'just text' },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, { queryWraps: async () => [wrap] });
    expect(out.mail).toHaveLength(1);
    expect(out.mail[0].from).toBe('?');
    expect(out.mail[0].to).toBe('?');
    expect(out.mail[0].subject).toBe('(no subject)');
    expect(out.mail[0].text).toBe('just text');
  });

  it('falls back when the parser returns nothing', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, {
      queryWraps: async () => [wrap],
      parse: async () => null,
    });
    expect(out.mail[0].subject).toBe('(no subject)');
    expect(out.mail[0].text).toBe(RFC822);
  });

  it('reports failed wraps individually without aborting the pass', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const stranger = makeKeypair();
    const good = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    // Encrypted to someone else: routine not-for-us.
    const foreign = wrapChain(
      { senderSk: sender.secretKey, recipientPk: stranger.pubkey },
      { recipientSk: stranger.secretKey },
    );
    // A NIP-17 DM (kind 14): not mail by default.
    const dm = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, kind: 14 },
      { recipientSk: recipient.secretKey },
    );
    const out = await readInbox(recipient.secretKey, {
      queryWraps: async () => [good.wrap, foreign.wrap, dm.wrap],
    });
    expect(out.mail).toHaveLength(1);
    expect(out.seenWrapIds).toHaveLength(3);
    expect(out.failures).toEqual([
      { wrapId: foreign.wrap.id, reason: 'not-for-us' },
      { wrapId: dm.wrap.id, reason: 'wrong-rumor-kind' },
    ]);
  });

  it('accepts widened rumor kinds and custom limits', async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const dm = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, kind: 14, content: 'note' },
      { recipientSk: recipient.secretKey },
    );
    let filter: Filter | undefined;
    const out = await readInbox(recipient.secretKey, {
      acceptKinds: [1301, 14],
      limit: 5,
      queryWraps: async (f) => {
        filter = f;
        return [dm.wrap];
      },
    });
    expect(filter?.limit).toBe(5);
    expect(out.failures).toHaveLength(0);
    expect(out.mail).toHaveLength(1);
    expect(out.mail[0].text).toBe('note');
  });
});

describe('readInboxWith — the signer path', () => {
  it("queries p-tagged to the signer's own pubkey and parses mail", async () => {
    const recipient = createIdentity();
    const sender = makeKeypair();
    const { rumor, wrap } = wrapChain(
      { senderSk: sender.secretKey, recipientPk: recipient.pubkey, content: RFC822 },
      { recipientSk: recipient.secretKey },
    );
    fakePool.registry.wraps = [wrap];
    const out = await readInboxWith(makeMailSigner(recipient.secretKey));
    expect(fakePool.registry.filter).toEqual({
      kinds: [1059],
      '#p': [recipient.pubkey],
      limit: 100,
    });
    expect(out.mail).toHaveLength(1);
    expect(out.mail[0].subject).toBe('Weekly update');
    expect(out.mail[0].raw).toBe(rumor.content);
  });
});