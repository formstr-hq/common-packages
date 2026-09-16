// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip04,
  nip19,
  nip44,
  verifyEvent,
} from 'nostr-tools';
import {
  Nip55WebSigner,
  browserNip55Transport,
  createSigner,
  type Nip55WebTransport,
} from '../src/index.js';
import type { StorageAdapter } from '../src/core/storage.js';

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

type PubkeyMode = 'hex' | 'npub' | 'nprofile';

interface ParsedIntent {
  payload: string;
  type: string;
  pubKey: string;
}

/**
 * Parse the `intent:<payload>#Intent;scheme=nostrsigner;S.key=value;...;end`
 * URI the signer hands to the OS. Mirrors the subset of Amber's IntentUtils
 * that reads extras, so the mock is a faithful stand-in.
 */
function parseIntent(intent: string): ParsedIntent {
  const body = intent.replace(/^intent:/, '');
  const hashIdx = body.indexOf('#Intent;');
  const payload = hashIdx >= 0 ? body.slice(0, hashIdx) : '';
  const rest = hashIdx >= 0 ? body.slice(hashIdx + '#Intent;'.length) : '';
  return {
    payload: payload ? decodeURIComponent(payload) : '',
    type: /(?:^|;)S\.type=([^;]+)/.exec(rest)?.[1] ?? '',
    pubKey: /(?:^|;)S\.pubKey=([^;]+)/.exec(rest)?.[1] ?? '',
  };
}

/**
 * Fake NIP-55 signer transport backed by a raw secret key.
 *
 * `writeClipboard` (the sentinel) sets the clipboard; `open` computes the
 * result the real signer would produce. When `holdResult` is set, `open`
 * leaves the clipboard alone to model the signer taking time, and
 * `deliver()` finishes the job.
 */
class FakeNip55Transport implements Nip55WebTransport {
  supported = true;
  pubkeyMode: PubkeyMode = 'hex';
  tamperSignature = false;
  failOpen: unknown = null;
  failRead: unknown = null;
  failWrite: unknown = null;
  /** When true, open() does not write a result (signer still working). */
  holdResult = false;
  /** When true, readClipboard hangs until resolveRead/rejectRead is called. */
  deferRead = false;
  /** When set, open() uses this instead of computing a result. */
  overrideResult: string | null = null;
  readonly opened: string[] = [];
  readonly wrote: string[] = [];
  clipboard = '';
  readonly secretKey: Uint8Array;
  #deferredRead: Array<{
    resolve(value: string): void;
    reject(error: unknown): void;
  }> = [];

  constructor(secretKey: Uint8Array) {
    this.secretKey = secretKey;
  }

  get pubkey(): string {
    return getPublicKey(this.secretKey);
  }

  isSupported(): boolean {
    return this.supported;
  }

  open(intent: string): void {
    if (this.failOpen) throw this.failOpen;
    this.opened.push(intent);
    if (!this.holdResult) this.clipboard = this.#result(intent);
  }

  /** Simulate the signer app finishing and writing its result. */
  deliver(intent?: string): void {
    this.clipboard = this.#result(intent ?? this.opened.at(-1) ?? '');
  }

  writeClipboard(text: string): Promise<void> {
    if (this.failWrite) return Promise.reject(this.failWrite);
    this.wrote.push(text);
    this.clipboard = text;
    return Promise.resolve();
  }

  readClipboard(): Promise<string> {
    if (this.deferRead) {
      return new Promise<string>((resolve, reject) => {
        this.#deferredRead.push({ resolve, reject });
      });
    }
    if (this.failRead) return Promise.reject(this.failRead);
    return Promise.resolve(this.clipboard);
  }

  /** Number of readClipboard() calls currently awaiting resolution. */
  pendingReads(): number {
    return this.#deferredRead.length;
  }

  resolveRead(value: string = this.clipboard): void {
    const read = this.#deferredRead.shift();
    if (!read) throw new Error('resolveRead: no deferred read pending');
    read.resolve(value);
  }

  rejectRead(error: unknown): void {
    const read = this.#deferredRead.shift();
    if (!read) throw new Error('rejectRead: no deferred read pending');
    read.reject(error);
  }

  /** The sentinel the signer planted for the most recent request. */
  get lastSentinel(): string {
    return this.wrote.at(-1) ?? '';
  }

  #result(intent: string): string {
    return this.overrideResult ?? this.#compute(intent);
  }

  #compute(intent: string): string {
    const { payload, type, pubKey } = parseIntent(intent);
    switch (type) {
      case 'get_public_key': {
        const pk = this.pubkey;
        if (this.pubkeyMode === 'npub') return nip19.npubEncode(pk);
        if (this.pubkeyMode === 'nprofile') return nip19.nprofileEncode({ pubkey: pk });
        return pk;
      }
      case 'sign_event':
        if (this.tamperSignature) return 'ab'.repeat(64);
        return finalizeEvent(JSON.parse(payload), this.secretKey).sig;
      case 'nip04_encrypt':
        return nip04.encrypt(this.secretKey, pubKey, payload);
      case 'nip04_decrypt':
        return nip04.decrypt(this.secretKey, pubKey, payload);
      case 'nip44_encrypt':
        return nip44.v2.encrypt(
          payload,
          nip44.v2.utils.getConversationKey(this.secretKey, pubKey),
        );
      case 'nip44_decrypt':
        return nip44.v2.decrypt(
          payload,
          nip44.v2.utils.getConversationKey(this.secretKey, pubKey),
        );
      default:
        return '';
    }
  }
}

const POLL = 5;

describe('NIP-55 web (intents + clipboard)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive every pending poll tick until `promise` settles. */
  async function settle<T>(promise: Promise<T>): Promise<T> {
    let settled = false;
    const tracked = promise.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    tracked.catch(() => undefined);
    for (let i = 0; i < 200 && !settled; i++) {
      await vi.advanceTimersByTimeAsync(POLL);
    }
    return tracked;
  }

  async function stillPending(promise: Promise<unknown>): Promise<boolean> {
    let settled = false;
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await vi.advanceTimersByTimeAsync(POLL * 4);
    await Promise.resolve();
    return !settled;
  }

  describe('intent builders', () => {
    it('builds the exact intent URIs the signer apps expect', () => {
      expect(Nip55WebSigner.getPublicKeyIntent()).toBe(
        'intent:#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;S.type=get_public_key;end',
      );
      expect(Nip55WebSigner.signEventIntent({ kind: 1 })).toBe(
        `intent:${encodeURIComponent(
          JSON.stringify({ kind: 1 }),
        )}#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;S.type=sign_event;end`,
      );
      expect(Nip55WebSigner.nip04EncryptIntent('ab'.repeat(32), 'hey')).toBe(
        `intent:${encodeURIComponent(
          'hey',
        )}#Intent;scheme=nostrsigner;S.pubKey=${'ab'.repeat(
          32,
        )};S.compressionType=none;S.returnType=signature;S.type=nip04_encrypt;end`,
      );
      expect(Nip55WebSigner.nip04DecryptIntent('cd'.repeat(32), 'ct')).toContain(
        'S.type=nip04_decrypt;end',
      );
      expect(Nip55WebSigner.nip44EncryptIntent('ef'.repeat(32), 'pt')).toContain(
        'S.type=nip44_encrypt;end',
      );
      expect(Nip55WebSigner.nip44DecryptIntent('12'.repeat(32), 'ct')).toContain(
        'S.type=nip44_decrypt;end',
      );
    });
  });

  describe('getPublicKey', () => {
    it('plants a sentinel, opens the app, and returns the changed clipboard', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });

      const pk = await settle(signer.getPublicKey());
      expect(pk).toBe(getPublicKey(sk));
      expect(transport.wrote).toHaveLength(1);
      expect(transport.lastSentinel).toMatch(/^__formstr_nip55_sentinel_/);
      expect(transport.opened).toHaveLength(1);
    });

    it('caches the pubkey and issues no further intent', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const pk = await settle(signer.getPublicKey());
      expect(await signer.getPublicKey()).toBe(pk);
      expect(transport.opened).toHaveLength(1);
      expect(transport.wrote).toHaveLength(1);
    });

    it('normalizes an npub result', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.pubkeyMode = 'npub';
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      expect(await settle(signer.getPublicKey())).toBe(getPublicKey(sk));
    });

    it('normalizes an nprofile result', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.pubkeyMode = 'nprofile';
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      expect(await settle(signer.getPublicKey())).toBe(getPublicKey(sk));
    });

    it('serves getPublicKey from the constructor cache without an intent', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({ transport, pubkey: getPublicKey(sk) });
      expect(await signer.getPublicKey()).toBe(getPublicKey(sk));
      expect(transport.opened).toHaveLength(0);
      expect(transport.wrote).toHaveLength(0);
    });

    it('throws for an undecodable identifier', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.overrideResult = 'not-a-key';
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      await expect(settle(signer.getPublicKey())).rejects.toThrow(
        /undecodable identifier/,
      );
    });

    it('throws for a non-pubkey bech32 identifier', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.overrideResult = nip19.nsecEncode(generateSecretKey());
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      await expect(settle(signer.getPublicKey())).rejects.toThrow(
        /non-pubkey identifier/,
      );
    });
  });

  describe('sentinel protects against a stale clipboard', () => {
    it('ignores the planted sentinel and waits for the real result', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      // open() leaves the clipboard holding the sentinel.
      transport.holdResult = true;
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const promise = signer.getPublicKey();
      // Several polls see only the sentinel -> must stay pending.
      expect(await stillPending(promise)).toBe(true);
      // Now the signer finishes.
      transport.deliver();
      expect(await settle(promise)).toBe(getPublicKey(sk));
    });

    it('does not mistake pre-existing clipboard text for a result', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.clipboard = 'stale-clipboard-from-before';
      transport.holdResult = true;
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const promise = signer.getPublicKey();
      expect(await stillPending(promise)).toBe(true);
      transport.deliver();
      expect(await settle(promise)).toBe(getPublicKey(sk));
    });

    it('falls back to the first non-empty read when the sentinel write fails', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.failWrite = new Error('clipboard write denied');
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      // open() writes the result; without a sentinel it is accepted directly.
      expect(await settle(signer.getPublicKey())).toBe(getPublicKey(sk));
      expect(transport.wrote).toHaveLength(0);
    });
  });

  describe('signEvent', () => {
    it('signs a valid event and verifies the signature', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({
        transport,
        pubkey: getPublicKey(sk),
        pollIntervalMs: POLL,
      });
      const signed = await settle(
        signer.signEvent({ kind: 1, content: 'gm', tags: [], created_at: 1000 }),
      );
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.pubkey).toBe(getPublicKey(sk));
      // Only a sign intent — the pubkey came from the cache.
      expect(transport.opened).toHaveLength(1);
      expect(parseIntent(transport.opened[0]!).type).toBe('sign_event');
    });

    it('resolves the pubkey first when there is no cache', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const signed = await settle(
        signer.signEvent({
          kind: 1,
          content: 'no cache',
          tags: [],
          created_at: 2000,
        }),
      );
      expect(verifyEvent(signed)).toBe(true);
      expect(transport.opened.map((i) => parseIntent(i).type)).toEqual([
        'get_public_key',
        'sign_event',
      ]);
      expect(transport.wrote).toHaveLength(2);
    });

    it('throws when the signature is not hex', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.overrideResult = 'zzz';
      const signer = new Nip55WebSigner({
        transport,
        pubkey: getPublicKey(sk),
        pollIntervalMs: POLL,
      });
      await expect(
        settle(signer.signEvent({ kind: 1, content: 'x', tags: [], created_at: 1 })),
      ).rejects.toThrow(/hex signature/);
    });

    it('throws when the signature does not verify', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.tamperSignature = true;
      const signer = new Nip55WebSigner({
        transport,
        pubkey: getPublicKey(sk),
        pollIntervalMs: POLL,
      });
      await expect(
        settle(signer.signEvent({ kind: 1, content: 'x', tags: [], created_at: 1 })),
      ).rejects.toThrow(/invalid signature/);
    });
  });

  describe('nip04 / nip44', () => {
    it('round-trips nip04 and nip44 against a peer', async () => {
      const userSk = generateSecretKey();
      const peerSk = generateSecretKey();
      const transport = new FakeNip55Transport(userSk);
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const peerPubkey = getPublicKey(peerSk);
      const userPubkey = getPublicKey(userSk);

      const ct44 = await settle(signer.nip44Encrypt(peerPubkey, 'hi 44'));
      expect(
        nip44.v2.decrypt(ct44, nip44.v2.utils.getConversationKey(peerSk, userPubkey)),
      ).toBe('hi 44');

      const peer44 = nip44.v2.encrypt(
        'back 44',
        nip44.v2.utils.getConversationKey(peerSk, userPubkey),
      );
      expect(await settle(signer.nip44Decrypt(peerPubkey, peer44))).toBe('back 44');

      const ct04 = await settle(signer.nip04Encrypt(peerPubkey, 'hi 04'));
      expect(nip04.decrypt(peerSk, userPubkey, ct04)).toBe('hi 04');

      const peer04 = nip04.encrypt(peerSk, userPubkey, 'back 04');
      expect(await settle(signer.nip04Decrypt(peerPubkey, peer04))).toBe('back 04');
    });
  });

  describe('failure handling', () => {
    it('throws before opening anything when the transport is unsupported', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.supported = false;
      const signer = new Nip55WebSigner({ transport });
      expect(signer.isSupported()).toBe(false);
      await expect(signer.getPublicKey()).rejects.toThrow(/Android browser/);
      await expect(
        signer.signEvent({ kind: 1, content: '', tags: [], created_at: 0 }),
      ).rejects.toThrow(/Android browser/);
      await expect(signer.nip04Encrypt('ab'.repeat(32), 'x')).rejects.toThrow(
        /Android browser/,
      );
      await expect(signer.nip04Decrypt('ab'.repeat(32), 'x')).rejects.toThrow(
        /Android browser/,
      );
      await expect(signer.nip44Encrypt('ab'.repeat(32), 'x')).rejects.toThrow(
        /Android browser/,
      );
      await expect(signer.nip44Decrypt('ab'.repeat(32), 'x')).rejects.toThrow(
        /Android browser/,
      );
      expect(transport.opened).toHaveLength(0);
    });

    it('keeps polling through read failures until the result arrives', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.failRead = new Error('Document is not focused');
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const promise = signer.getPublicKey();
      expect(await stillPending(promise)).toBe(true);
      // Focus returns and the read starts working.
      transport.failRead = null;
      expect(await settle(promise)).toBe(getPublicKey(sk));
    });

    it('keeps polling through empty reads', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.overrideResult = '';
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const promise = signer.getPublicKey();
      expect(await stillPending(promise)).toBe(true);
      transport.overrideResult = null;
      transport.deliver();
      expect(await settle(promise)).toBe(getPublicKey(sk));
    });

    it('rejects when opening the intent throws', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.failOpen = new Error('blocked by browser');
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      await expect(settle(signer.getPublicKey())).rejects.toThrow(
        /blocked by browser/,
      );
    });

    it('rejects a superseded request and cleans up', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const first = signer.getPublicKey();
      const second = signer.getPublicKey();
      await expect(first).rejects.toThrow(/superseded/);
      expect(await settle(second)).toBe(getPublicKey(sk));
    });

    it('discards a poll that resolves after the request was superseded', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.deferRead = true;
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const first = signer.getPublicKey();
      // Let the sentinel write land and the first poll start.
      await vi.advanceTimersByTimeAsync(POLL);
      await Promise.resolve();
      expect(transport.pendingReads()).toBeGreaterThan(0);

      const second = signer.getPublicKey();
      await expect(first).rejects.toThrow(/superseded/);

      // Release the stale read — it must not resolve the second request.
      while (transport.pendingReads() > 0) transport.resolveRead('stale');
      transport.deferRead = false;
      expect(await settle(second)).toBe(getPublicKey(sk));
    });

    it('close() cancels an in-flight request', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.holdResult = true;
      const signer = new Nip55WebSigner({ transport, pollIntervalMs: POLL });
      const promise = signer.getPublicKey();
      await vi.advanceTimersByTimeAsync(POLL);
      const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      signer.close();
      await expectation;
      // A second close with nothing pending is a no-op.
      expect(() => signer.close()).not.toThrow();
    });

    it('close() does not permanently disable the signer', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const signer = new Nip55WebSigner({
        transport,
        pubkey: getPublicKey(sk),
        pollIntervalMs: POLL,
      });
      signer.close();
      const signed = await settle(
        signer.signEvent({ kind: 1, content: 'still works', tags: [], created_at: 1 }),
      );
      expect(verifyEvent(signed)).toBe(true);
    });

    it('emits diagnostics through the debug sink', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const messages: string[] = [];
      const signer = new Nip55WebSigner({
        transport,
        pollIntervalMs: POLL,
        debug: (m) => messages.push(m),
      });
      await settle(signer.getPublicKey());
      expect(messages.some((m) => m.includes('planted clipboard sentinel'))).toBe(true);
      expect(messages.some((m) => m.includes('opening signer app'))).toBe(true);
      expect(messages.some((m) => m.includes('clipboard result'))).toBe(true);
    });

    it('logs a sentinel write failure', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.failWrite = new Error('denied');
      const messages: string[] = [];
      const signer = new Nip55WebSigner({
        transport,
        pollIntervalMs: POLL,
        debug: (m) => messages.push(m),
      });
      await settle(signer.getPublicKey());
      expect(messages.some((m) => m.includes('sentinel write failed'))).toBe(true);
    });

    it('logs a clipboard read failure', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.failRead = new Error('not focused');
      const messages: string[] = [];
      const signer = new Nip55WebSigner({
        transport,
        pollIntervalMs: POLL,
        debug: (m) => messages.push(m),
      });
      const promise = signer.getPublicKey();
      await vi.advanceTimersByTimeAsync(POLL * 2);
      transport.failRead = null;
      await settle(promise);
      expect(messages.some((m) => m.includes('clipboard read failed'))).toBe(true);
    });
  });

  describe('timeout and abort', () => {
    it('rejects when the signer never returns a result', async () => {
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.holdResult = true;
      const signer = new Nip55WebSigner({
        transport,
        pollIntervalMs: POLL,
        timeoutMs: 1000,
      });
      const promise = signer.getPublicKey();
      const expectation = expect(promise).rejects.toThrow(/timed out after 1000ms/);
      await vi.advanceTimersByTimeAsync(2000);
      await expectation;
    });

    it('timeoutMs: 0 disables the timeout', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.holdResult = true;
      const signer = new Nip55WebSigner({
        transport,
        pollIntervalMs: POLL,
        timeoutMs: 0,
      });
      const promise = signer.getPublicKey();
      await vi.advanceTimersByTimeAsync(300_000);
      transport.deliver();
      await vi.advanceTimersByTimeAsync(POLL);
      expect(await promise).toBe(getPublicKey(sk));
    });

    it('an aborted signal rejects a new request immediately', async () => {
      const controller = new AbortController();
      controller.abort();
      const transport = new FakeNip55Transport(generateSecretKey());
      const signer = new Nip55WebSigner({
        transport,
        signal: controller.signal,
        pollIntervalMs: POLL,
      });
      await expect(signer.getPublicKey()).rejects.toMatchObject({ name: 'AbortError' });
      expect(transport.opened).toHaveLength(0);
    });

    it('aborting mid-flight rejects the pending request', async () => {
      const controller = new AbortController();
      const transport = new FakeNip55Transport(generateSecretKey());
      transport.holdResult = true;
      const signer = new Nip55WebSigner({
        transport,
        signal: controller.signal,
        pollIntervalMs: POLL,
      });
      const promise = signer.getPublicKey();
      await vi.advanceTimersByTimeAsync(POLL);
      const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await expectation;
    });
  });

  describe('Signer integration', () => {
    it('loginWithNip55Web persists a nip55-web account and activates the signer', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });
      const account = await settle(s.loginWithNip55Web({ pollIntervalMs: POLL }));
      expect(account.method).toBe('nip55-web');
      expect(account.pubkey).toBe(getPublicKey(sk));
      expect(account.npub).toBe(nip19.npubEncode(getPublicKey(sk)));
      expect(s.getActiveSigner()).toBeInstanceOf(Nip55WebSigner);
      expect(JSON.parse(storage.dump()['accounts']!)[0].method).toBe('nip55-web');
    });

    it('does not let a login signal poison the signer after pairing', async () => {
      // Regression: hosts abort the login controller once the modal closes
      // on success. That signal belongs to the pairing attempt, so the
      // account must keep working afterwards.
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });

      const controller = new AbortController();
      await settle(
        s.loginWithNip55Web({ pollIntervalMs: POLL, signal: controller.signal }),
      );
      // The modal closed, so the host aborts its controller.
      controller.abort();

      const active = s.getActiveSigner()!;
      const signed = await settle(
        active.signEvent({ kind: 1, content: 'after abort', tags: [], created_at: 9 }),
      );
      expect(verifyEvent(signed)).toBe(true);
    });

    it('still rejects the pairing when the login signal aborts mid-flight', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      transport.holdResult = true;
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });

      const controller = new AbortController();
      const promise = s.loginWithNip55Web({
        pollIntervalMs: POLL,
        signal: controller.signal,
      });
      await vi.advanceTimersByTimeAsync(POLL);
      const expectation = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await expectation;
      expect(s.listAccounts()).toHaveLength(0);
    });

    it('resumes from persisted state on unlock without opening the signer', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const pubkey = getPublicKey(sk);
      storage.set(
        'accounts',
        JSON.stringify([{ npub: nip19.npubEncode(pubkey), pubkey, method: 'nip55-web' }]),
      );
      storage.set('active-pubkey', pubkey);

      const s = createSigner({ storage, nip55WebTransport: transport });
      const unlocked = await s.unlock();
      expect(unlocked).toBeInstanceOf(Nip55WebSigner);
      // Unlock must not open the signer app — no intents, no clipboard writes.
      expect(transport.opened).toHaveLength(0);
      expect(transport.wrote).toHaveLength(0);
      expect(await unlocked!.getPublicKey()).toBe(pubkey);

      // Signing still goes through the transport.
      const signed = await settle(
        unlocked!.signEvent({
          kind: 1,
          content: 'after unlock',
          tags: [],
          created_at: 5,
        }),
      );
      expect(verifyEvent(signed)).toBe(true);
      expect(transport.opened).toHaveLength(1);
    });

    it('loginWithNip55Web uses the browser default when no transport is configured', async () => {
      const s = createSigner({ storage: makeMockStorage() });
      // happy-dom's navigator is not Android, so the default transport is
      // unsupported and login fails before persisting anything.
      await expect(s.loginWithNip55Web()).rejects.toThrow(/Android browser/);
      expect(s.listAccounts()).toHaveLength(0);
    });

    it('switchAccount closes the outgoing signer', async () => {
      const skA = generateSecretKey();
      const skB = generateSecretKey();
      const transport = new FakeNip55Transport(skA);
      const storage = makeMockStorage();

      const s = createSigner({ storage, nip55WebTransport: transport });
      await settle(s.loginWithNip55Web({ pollIntervalMs: POLL }));

      // Seed a second account directly — we only need it as a switch target.
      const accounts = JSON.parse(storage.dump()['accounts']!);
      accounts.push({
        npub: nip19.npubEncode(getPublicKey(skB)),
        pubkey: getPublicKey(skB),
        method: 'extension',
      });
      storage.set('accounts', JSON.stringify(accounts));
      const s2 = createSigner({ storage, nip55WebTransport: transport });
      await s2.unlock();
      const outgoing = s2.getActiveSigner() as Nip55WebSigner;
      const closeSpy = vi.spyOn(outgoing, 'close');

      await s2.switchAccount(getPublicKey(skB));
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(s2.getActiveSigner()).toBeNull();
    });

    it('logout closes the active signer', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });
      await settle(s.loginWithNip55Web({ pollIntervalMs: POLL }));
      const active = s.getActiveSigner() as Nip55WebSigner;
      const closeSpy = vi.spyOn(active, 'close');
      await s.logout();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(s.getActiveSigner()).toBeNull();
    });

    it('tolerates a close() that rejects (async teardown)', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });
      await settle(s.loginWithNip55Web({ pollIntervalMs: POLL }));
      const active = s.getActiveSigner() as Nip55WebSigner;
      // BunkerSigner's close() is async; simulate a rejecting promise.
      vi.spyOn(active, 'close').mockImplementation(
        () => Promise.reject(new Error('relay gone')) as unknown as void,
      );
      await expect(s.logout()).resolves.toBeUndefined();
      expect(s.getActiveSigner()).toBeNull();
    });

    it('tolerates a close() that throws synchronously', async () => {
      const sk = generateSecretKey();
      const transport = new FakeNip55Transport(sk);
      const storage = makeMockStorage();
      const s = createSigner({ storage, nip55WebTransport: transport });
      await settle(s.loginWithNip55Web({ pollIntervalMs: POLL }));
      const active = s.getActiveSigner() as Nip55WebSigner;
      vi.spyOn(active, 'close').mockImplementation(() => {
        throw new Error('boom');
      });
      await expect(s.logout()).resolves.toBeUndefined();
      expect(s.getActiveSigner()).toBeNull();
    });
  });

  describe('browserNip55Transport', () => {
    const realUA = navigator.userAgent;

    beforeEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: realUA,
        configurable: true,
      });
    });

    afterEach(() => {
      Object.defineProperty(navigator, 'userAgent', {
        value: realUA,
        configurable: true,
      });
    });

    it('reports unsupported on a non-Android UA', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Macintosh)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText: async () => '' },
        configurable: true,
      });
      expect(browserNip55Transport().isSupported()).toBe(false);
    });

    it('reports unsupported when the async clipboard is missing', () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14)',
        configurable: true,
      });
      Object.defineProperty(navigator, 'clipboard', {
        value: undefined,
        configurable: true,
      });
      expect(browserNip55Transport().isSupported()).toBe(false);
    });

    it('opens intents, reads and writes the clipboard', async () => {
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Linux; Android 14; Pixel)',
        configurable: true,
      });
      const readText = vi.fn().mockResolvedValue('signed');
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { readText, writeText },
        configurable: true,
      });
      const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
      const transport = browserNip55Transport();

      expect(transport.isSupported()).toBe(true);
      transport.open('intent:test');
      expect(openSpy).toHaveBeenCalledWith('intent:test', '_blank');
      expect(await transport.readClipboard()).toBe('signed');
      await transport.writeClipboard('sentinel');
      expect(writeText).toHaveBeenCalledWith('sentinel');

      openSpy.mockRestore();
    });
  });
});
