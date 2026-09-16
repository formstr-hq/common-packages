import {
  getEventHash,
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import type { ActiveSigner } from './core/types.js';
import { normalizeNip55Identifier } from './nip55.js';

/**
 * NIP-55 over the web, without a Capacitor/native bridge.
 *
 * A plain browser page cannot call an Android signer in the background, so
 * this transport hands the OS a `nostrsigner` intent and then reads the
 * result back from the **clipboard** once the user returns to the tab. It
 * is the mechanism used by applesauce's `AmberClipboardSigner` and
 * gitworkshop's "Use Amber" button; no package is named in the intent, so
 * Android resolves it against whatever app registered the scheme — one
 * installed signer opens directly, several show the "Open with" chooser.
 *
 * The alternative NIP-55 web path — `?callbackUrl=` — is not used here: it
 * navigates the page away and back, which cannot be hidden behind a
 * promise-returning {@link ActiveSigner}. Use NIP-46 when a persistent
 * session is wanted; the spec recommends it for web clients.
 *
 * @see https://github.com/nostr-protocol/nips/blob/master/55.md
 */
export interface Nip55WebTransport {
  /**
   * Whether this environment can run the intent + clipboard flow at all.
   * The package's browser transport requires an Android user agent and the
   * async clipboard API; anything else must fail loudly rather than open a
   * dead intent.
   */
  isSupported(): boolean;
  /** Hand the intent URI to the OS (a browser typically `window.open`s it). */
  open(intent: string): void;
  /** Read the current clipboard text. */
  readClipboard(): Promise<string>;
  /**
   * Overwrite the clipboard. Used to plant a sentinel before opening the
   * signer, so the result can be told apart from whatever the user had
   * copied earlier. Best-effort — a failure just means we fall back to
   * accepting the first non-empty read.
   */
  writeClipboard(text: string): Promise<void>;
}

export interface Nip55WebOptions {
  /**
   * Environment bridge. Defaults to a browser implementation
   * ({@link browserNip55Transport}). Tests inject a fake.
   */
  transport?: Nip55WebTransport;
  /**
   * Cached user pubkey. When supplied, {@link Nip55WebSigner.getPublicKey}
   * returns it without a signer roundtrip — used on cold start to avoid a
   * fresh `get_public_key` approval prompt for an already-paired account.
   */
  pubkey?: string;
  /**
   * How often to poll the clipboard while waiting for the signer app to
   * return a result. Default 500ms.
   *
   * Polling, not events: on Android Chrome the return from the signer app
   * fires **no** `visibilitychange`/`focus` event at all (the tab was never
   * reported hidden), so an event-driven read simply never happens.
   * `setInterval` keeps running while the tab is backgrounded, so polling
   * is what actually observes the result.
   */
  pollIntervalMs?: number;
  /**
   * Max time to wait for the signer app to return a result. A rejection is
   * invisible over NIP-55 web (the app just never calls back), so without
   * this a denied or abandoned request hangs forever. Default 120000ms;
   * `0` disables the timeout.
   */
  timeoutMs?: number;
  /**
   * Lifetime abort. Aborts the in-flight request and makes every future
   * request reject immediately (rejections carry `name === 'AbortError'`,
   * matching the NIP-46 flow).
   *
   * This is a property of the *signer*, not of one attempt. Do **not**
   * pass a controller that is aborted once a login modal closes — that
   * would leave the signer permanently unusable. To cancel a single
   * pairing attempt, use {@link Signer.loginWithNip55Web}'s `signal`.
   */
  signal?: AbortSignal;
  /**
   * Diagnostic sink for the intent/clipboard round-trip. The flow is hard
   * to observe (it leaves the page and returns), so a host can pass a
   * logger — e.g. to an on-screen list — to see what actually happened.
   */
  debug?: (message: string) => void;
}

interface PendingRequest {
  resolve(value: string): void;
  reject(error: unknown): void;
  /** The value planted before opening the signer, if the write succeeded. */
  sentinel: string | null;
  /** Interval id for the clipboard poll; cleared on settle. */
  poll: ReturnType<typeof setInterval> | null;
  /** Request timeout; cleared on settle. `null` when disabled. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Abort listener; removed on settle. `null` when no signal was given. */
  onAbort: (() => void) | null;
}

const DEFAULT_POLL_INTERVAL_MS = 500;
const DEFAULT_TIMEOUT_MS = 120_000;

let sentinelCounter = 0;

/**
 * A clipboard value guaranteed not to collide with a real signer result.
 * Written before the intent so polling can tell "the app has answered"
 * apart from "the user's clipboard still holds yesterday's copy".
 */
function makeSentinel(): string {
  sentinelCounter += 1;
  return `__formstr_nip55_sentinel_${Date.now()}_${sentinelCounter}__`;
}

function abortError(): Error {
  const error = new Error('@formstr/signer: NIP-55 request aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Browser transport: `window.open` for the intent, `navigator.clipboard`
 * for the result, `visibilitychange` for the return. Globals are read
 * lazily so importing this module stays safe in Node.
 */
export function browserNip55Transport(): Nip55WebTransport {
  return {
    isSupported() {
      return (
        typeof navigator !== 'undefined' &&
        /Android/i.test(navigator.userAgent) &&
        typeof navigator.clipboard?.readText === 'function'
      );
    },
    open(intent) {
      window.open(intent, '_blank');
    },
    readClipboard() {
      return navigator.clipboard.readText();
    },
    writeClipboard(text) {
      return navigator.clipboard.writeText(text);
    },
  };
}

/**
 * {@link ActiveSigner} backed by any installed NIP-55 signer app, used from
 * a plain (Android) browser via intents + clipboard.
 *
 * Every operation is a separate user approval — there is no background
 * channel and no way to learn that the user rejected a request, so callers
 * must impose their own timeout (the flow simply never resolves otherwise).
 */
export class Nip55WebSigner implements ActiveSigner {
  readonly #transport: Nip55WebTransport;
  readonly #pollIntervalMs: number;
  readonly #timeoutMs: number;
  readonly #signal: AbortSignal | undefined;
  readonly #debug: ((message: string) => void) | undefined;
  #pending: PendingRequest | null = null;
  #pubkey: string | null = null;

  constructor(options: Nip55WebOptions = {}) {
    this.#transport = options.transport ?? browserNip55Transport();
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#signal = options.signal;
    this.#debug = options.debug;
    this.#pubkey = options.pubkey ?? null;
  }

  #log(message: string): void {
    this.#debug?.(message);
  }

  /** True when the configured transport can actually open a signer app. */
  isSupported(): boolean {
    return this.#transport.isSupported();
  }

  async getPublicKey(): Promise<string> {
    if (this.#pubkey !== null) return this.#pubkey;
    this.#checkSupport();
    const raw = await this.#request(Nip55WebSigner.getPublicKeyIntent());
    const { pubkey } = normalizeNip55Identifier(raw);
    this.#pubkey = pubkey;
    return pubkey;
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    this.#checkSupport();
    const pubkey = this.#pubkey ?? (await this.getPublicKey());
    const unsigned = { ...event, pubkey };
    const draftWithId = { ...unsigned, id: getEventHash(unsigned) };
    const sig = (
      await this.#request(Nip55WebSigner.signEventIntent(draftWithId))
    ).trim();
    if (!/^[0-9a-f]{128}$/i.test(sig)) {
      throw new Error(
        '@formstr/signer: NIP-55 signer did not return a hex signature',
      );
    }
    const signed: NostrEvent = { ...draftWithId, sig: sig.toLowerCase() };
    if (!verifyEvent(signed)) {
      throw new Error('@formstr/signer: NIP-55 signer returned an invalid signature');
    }
    return signed;
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    this.#checkSupport();
    return this.#request(Nip55WebSigner.nip04EncryptIntent(peerPubkey, plaintext));
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    this.#checkSupport();
    return this.#request(Nip55WebSigner.nip04DecryptIntent(peerPubkey, ciphertext));
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    this.#checkSupport();
    return this.#request(Nip55WebSigner.nip44EncryptIntent(peerPubkey, plaintext));
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    this.#checkSupport();
    return this.#request(Nip55WebSigner.nip44DecryptIntent(peerPubkey, ciphertext));
  }

  /**
   * Cancel any in-flight request and stop its clipboard poll. Subsequent
   * operations still work — this is a teardown of live resources, not a
   * permanent disable (the {@link Signer} calls it when replacing the
   * active signer).
   */
  close(): void {
    if (this.#pending) {
      const pending = this.#pending;
      this.#settle();
      pending.reject(abortError());
    }
  }

  #checkSupport(): void {
    if (!this.#transport.isSupported()) {
      throw new Error(
        '@formstr/signer: NIP-55 web signing requires an Android browser with clipboard access (a signer app registering the `nostrsigner` scheme must be installed)',
      );
    }
  }

  /** One poll tick: read the clipboard and settle if the signer answered. */
  #poll = async (pending: PendingRequest): Promise<void> => {
    let text: string;
    try {
      text = await this.#transport.readClipboard();
    } catch (error) {
      // NotAllowedError until the page regains focus; keep polling.
      this.#log(`clipboard read failed: ${(error as Error).message}`);
      return;
    }
    // A read can resume after the request was superseded/settled while it
    // was in flight; the interval is cleared then, but this tick is already
    // running. Drop it rather than resolving the wrong request.
    if (this.#pending !== pending) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // With a sentinel we require a *change*; without one (the write failed)
    // accept any non-empty value, matching the pre-sentinel behaviour.
    if (pending.sentinel !== null && trimmed === pending.sentinel) return;
    this.#log(`clipboard result (${trimmed.length} chars)`);
    this.#settle();
    pending.resolve(trimmed);
  };

  #request(intent: string): Promise<string> {
    this.#checkAborted();
    this.#cancelPending();
    return new Promise<string>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        sentinel: null,
        poll: null,
        timer: null,
        onAbort: null,
      };
      this.#pending = pending;
      if (this.#signal) {
        const onAbort = () => this.#fail(pending, abortError());
        this.#signal.addEventListener('abort', onAbort);
        pending.onAbort = onAbort;
      }
      if (this.#timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#fail(
            pending,
            new Error(
              `@formstr/signer: NIP-55 request timed out after ${this.#timeoutMs}ms (the signer app never returned a result)`,
            ),
          );
        }, this.#timeoutMs);
      }

      // Plant a sentinel before opening the signer. Without it, a stale
      // clipboard from an earlier approval would look like a fresh result
      // and resolve immediately. Best-effort: if the write is refused we
      // proceed without it rather than failing the whole flow.
      void (async () => {
        try {
          const sentinel = makeSentinel();
          await this.#transport.writeClipboard(sentinel);
          if (this.#pending === pending) pending.sentinel = sentinel;
          this.#log('planted clipboard sentinel');
        } catch (error) {
          this.#log(`sentinel write failed: ${(error as Error).message}`);
        }
        if (this.#pending !== pending) return;
        try {
          this.#log(`opening signer app: ${intent.slice(0, 80)}…`);
          this.#transport.open(intent);
        } catch (error) {
          this.#fail(pending, error);
          return;
        }
        // Start polling only after the intent is out; the sentinel write and
        // open are skipped on the very first ticks otherwise.
        pending.poll = setInterval(() => {
          void this.#poll(pending);
        }, this.#pollIntervalMs);
      })();
    });
  }

  /**
   * Reject the current request. Every caller is cleared on settle — the
   * timeout timer and abort listener are removed, and `open()` is
   * synchronous — so `pending` is always the active request here.
   */
  #fail(pending: PendingRequest, error: unknown): void {
    this.#settle();
    pending.reject(error);
  }

  #settle(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (pending?.poll) clearInterval(pending.poll);
    if (pending?.timer) clearTimeout(pending.timer);
    if (pending?.onAbort && this.#signal) {
      this.#signal.removeEventListener('abort', pending.onAbort);
    }
  }

  #cancelPending(): void {
    if (!this.#pending) return;
    const pending = this.#pending;
    this.#settle();
    pending.reject(new Error('@formstr/signer: NIP-55 request superseded'));
  }

  #checkAborted(): void {
    if (this.#signal?.aborted) throw abortError();
  }

  static getPublicKeyIntent(): string {
    return 'intent:#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;S.type=get_public_key;end';
  }

  static signEventIntent(draft: object): string {
    return `intent:${encodeURIComponent(
      JSON.stringify(draft),
    )}#Intent;scheme=nostrsigner;S.compressionType=none;S.returnType=signature;S.type=sign_event;end`;
  }

  static nip04EncryptIntent(peerPubkey: string, plaintext: string): string {
    return Nip55WebSigner.#cryptoIntent('nip04_encrypt', peerPubkey, plaintext);
  }

  static nip04DecryptIntent(peerPubkey: string, ciphertext: string): string {
    return Nip55WebSigner.#cryptoIntent('nip04_decrypt', peerPubkey, ciphertext);
  }

  static nip44EncryptIntent(peerPubkey: string, plaintext: string): string {
    return Nip55WebSigner.#cryptoIntent('nip44_encrypt', peerPubkey, plaintext);
  }

  static nip44DecryptIntent(peerPubkey: string, ciphertext: string): string {
    return Nip55WebSigner.#cryptoIntent('nip44_decrypt', peerPubkey, ciphertext);
  }

  static #cryptoIntent(
    type: 'nip04_encrypt' | 'nip04_decrypt' | 'nip44_encrypt' | 'nip44_decrypt',
    peerPubkey: string,
    payload: string,
  ): string {
    return `intent:${encodeURIComponent(
      payload,
    )}#Intent;scheme=nostrsigner;S.pubKey=${peerPubkey};S.compressionType=none;S.returnType=signature;S.type=${type};end`;
  }
}
