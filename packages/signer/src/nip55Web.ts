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
/** Why the browser NIP-55 flow cannot run here. */
export type Nip55WebSupportReason =
  | 'native'
  | 'not-android'
  | 'no-clipboard'
  | 'firefox';

/**
 * Whether the browser NIP-55 option should be shown, plus an advisory
 * warning where it is known to be flaky.
 *
 * Visibility and warnings are deliberately separate, and nothing is
 * hard-blocked. The option is hidden only where the mechanism cannot exist
 * at all — a Capacitor native shell (the plugin path is strictly better)
 * and non-Android platforms (the `nostrsigner` intent cannot resolve).
 *
 * Firefox for Android is **shown with a warning** rather than blocked. It
 * advertises `readText` but never grants a persistent permission, so every
 * read needs transient activation and the poll loop cannot complete —
 * verified on an emulator (Firefox 125). We still let the user try, because
 * blocking a browser outright is a worse failure than a warning, and
 * browser behaviour changes.
 */
export interface Nip55WebSupport {
  /** Render the option at all. False in native shells and on non-Android. */
  visible: boolean;
  /**
   * Advisory, non-blocking message to show beside the option. The flow
   * remains attemptable; this only sets expectations.
   */
  warning?: string;
  /** Machine-readable reason for the warning / hidden state. */
  reason?: Nip55WebSupportReason;
}

export interface Nip55WebTransport {
  /**
   * Whether this environment can run the intent + clipboard flow at all.
   * The package's browser transport requires an Android user agent and the
   * async clipboard API; anything else must fail loudly rather than open a
   * dead intent.
   */
  isSupported(): boolean;
  /**
   * Richer form of {@link isSupported}: whether to *offer* the option and
   * whether it actually works. Hosts should prefer this so they can show an
   * explanatory hint (e.g. "does not work on Firefox") rather than hide a
   * capability that other browsers on the same device do have.
   */
  supportStatus?(): Nip55WebSupport;
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
  /** The intent to open once this request reaches the head of the queue. */
  intent: string;
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

/**
 * The window name intent URIs are opened under.
 *
 * `window.open(intent, '_blank')` asks the browser to create a **new** browsing
 * context every call, so a burst of signer operations opened a burst of tabs and
 * none were ever closed — enough to crash a phone browser. A fixed name instead
 * reuses (navigates) one tab: the OS intent is honoured, but there is never more
 * than one signer window.
 */
const SIGNER_WINDOW_NAME = 'formstr-nip55-signer';

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

/** Capacitor's injected global, when running inside a native shell. */
interface CapacitorGlobalLike {
  isNativePlatform?: () => boolean;
}

/**
 * True when the page is running inside a Capacitor native shell (the
 * Android/iOS app) rather than a plain browser. Capacitor injects a
 * `Capacitor` global into the WebView, so this needs no dependency on
 * `@capacitor/core` — which the package deliberately does not pull in.
 */
function isNativeShell(): boolean {
  const cap = (globalThis as { Capacitor?: CapacitorGlobalLike }).Capacitor;
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform();
}

/**
 * True for Gecko-based Android browsers (Firefox/Fenix, Focus, Klar).
 *
 * These are the one environment that reports `navigator.clipboard.readText`
 * yet cannot run this flow. Firefox for Android never grants a persistent
 * `clipboard-read` permission: every read needs transient user activation
 * and is answered with an ephemeral "Paste" menu, so a background poll can
 * only ever fail (verified on an emulator, Firefox 125 — even directly
 * inside a click handler, with focus and user activation, `readText()`
 * rejects with "Clipboard read operation is not allowed").
 *
 * UA sniffing is used because there is no synchronous feature test for
 * "does reading require activation". `Gecko/` is checked alongside the
 * product tokens so Focus/Klar are caught too; Chromium UAs only ever say
 * "like Gecko", never "Gecko/".
 *
 * `navigator` is guaranteed by the caller — `supportStatus` returns before
 * this in a DOM-less environment.
 */
function isGeckoBrowser(): boolean {
  const ua = navigator.userAgent;
  return /Firefox\/|FxiOS\/|Focus\/|Gecko\//.test(ua);
}

/**
 * Browser transport: `window.open` for the intent, `navigator.clipboard`
 * for the result. Globals are read lazily so importing this module stays
 * safe in Node.
 *
 * This transport is for a **plain browser only**. Inside a Capacitor
 * native shell the same device has the real NIP-55 plugin, which supports
 * every method and does not need the clipboard or a per-operation
 * approval, so this flow is not offered there — a native host should use
 * `loginWithAndroidSigner` instead.
 */
export function browserNip55Transport(): Nip55WebTransport {
  return {
    supportStatus() {
      // Server-side rendering / plain Node: no DOM, so nothing to offer.
      if (typeof navigator === 'undefined') {
        return { visible: false, reason: 'not-android' as const };
      }
      // A Capacitor shell has the real NIP-55 plugin, which is strictly
      // better (every method, no clipboard, no per-operation approval), so
      // the browser flow is not offered there at all.
      if (isNativeShell()) {
        return { visible: false, reason: 'native' as const };
      }
      if (!/Android/i.test(navigator.userAgent)) {
        return { visible: false, reason: 'not-android' as const };
      }
      if (typeof navigator.clipboard?.readText !== 'function') {
        return { visible: false, reason: 'no-clipboard' as const };
      }
      if (isGeckoBrowser()) {
        // Shown, but flagged: every read needs transient activation, so the
        // poll loop cannot complete. Still attemptable on purpose.
        return {
          visible: true,
          reason: 'firefox' as const,
          warning:
            'May not work in Firefox for Android — the clipboard usually cannot be read automatically. If it hangs, try Chrome, Brave, or the Android app.',
        };
      }
      return { visible: true };
    },
    isSupported() {
      // "Has the API surface", not "is guaranteed to work": Firefox returns
      // true here and is allowed to try, with a warning from supportStatus().
      return this.supportStatus!().visible;
    },
    open(intent) {
      // A stable window NAME, not '_blank'. `_blank` asks for a brand-new
      // browsing context on every call, so one signer operation per tab — a
      // mailbox's concurrent decrypts would spawn a tab per message and crash
      // the browser. A fixed name reuses a single tab across the whole session.
      window.open(intent, SIGNER_WINDOW_NAME);
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
  /**
   * The one request currently occupying the signer, if any.
   *
   * NIP-55 web allows exactly one approval at a time — there is one signer
   * window and one clipboard — so operations are serialized rather than run
   * concurrently. A burst (the mail app decrypts up to three wraps at once)
   * is queued, not coalesced or dropped.
   */
  #active: PendingRequest | null = null;
  /** Requests waiting for the signer, oldest first. */
  #queue: PendingRequest[] = [];
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

  /**
   * Whether to offer the option and whether it works. Prefer this over
   * {@link isSupported} so a host can surface `message` — notably the
   * Firefox case, which is shown but cannot complete.
   */
  supportStatus(): Nip55WebSupport {
    const status = this.#transport.supportStatus;
    if (status) return status.call(this.#transport);
    // A custom transport without `supportStatus` only gets a boolean, so we
    // can't add a warning; just mirror visibility.
    return { visible: this.#transport.isSupported() };
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
   * Cancel the in-flight request and drop anything queued behind it. Subsequent
   * operations still work — this is a teardown of live resources, not a
   * permanent disable (the {@link Signer} calls it when replacing the
   * active signer).
   */
  close(): void {
    this.#cancelAll();
  }

  #checkSupport(): void {
    const { visible, reason } = this.supportStatus();
    // A warning (e.g. Firefox) does not block — the user is allowed to try.
    if (visible) return;
    if (reason === 'native') {
      throw new Error(
        '@formstr/signer: the browser NIP-55 flow is not for native builds — use loginWithAndroidSigner() with the Capacitor plugin instead',
      );
    }
    throw new Error(
      '@formstr/signer: NIP-55 web signing requires an Android browser with clipboard access (a signer app registering the `nostrsigner` scheme must be installed)',
    );
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
    // A read can resume after the request was settled while it was in flight;
    // the interval is cleared then, but this tick is already running. Drop it
    // rather than resolving the wrong request.
    if (this.#active !== pending) return;
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    // With a sentinel we require a *change*; without one (the write failed)
    // accept any non-empty value, matching the pre-sentinel behaviour.
    if (pending.sentinel !== null && trimmed === pending.sentinel) return;
    this.#log(`clipboard result (${trimmed.length} chars)`);
    // Settle BEFORE resolving so the next queued request can start.
    this.#settle(pending);
    pending.resolve(trimmed);
  };

  /**
   * Enqueue one operation. NIP-55 web has a single signer window and a single
   * clipboard, so only one request may be in flight at a time; a second call
   * (e.g. concurrent mail decrypts) waits its turn instead of cancelling the
   * first. The timeout clock starts when the request reaches the head of the
   * queue, not when it is enqueued — otherwise a long queue would time out
   * requests the signer never got a chance to answer.
   */
  #request(intent: string): Promise<string> {
    this.#checkAborted();
    return new Promise<string>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        intent,
        sentinel: null,
        poll: null,
        timer: null,
        onAbort: null,
      };
      if (this.#signal) {
        // A lifetime abort tears down everything outstanding, not just one
        // attempt: the signer is being discarded (account switch), so every
        // queued and in-flight request must reject.
        const onAbort = () => this.#cancelAll();
        this.#signal.addEventListener('abort', onAbort);
        pending.onAbort = onAbort;
      }
      this.#queue.push(pending);
      this.#pump();
    });
  }

  /** Start the next queued request if the signer is free. */
  #pump(): void {
    if (this.#active || this.#queue.length === 0) return;
    const pending = this.#queue.shift()!;
    this.#active = pending;

    // The timeout runs only while this request owns the signer.
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
        // Guard against the request settling (close/abort) while the async
        // write was in flight — a settled request must not claim a sentinel
        // or, below, open a window.
        if (this.#active === pending) pending.sentinel = sentinel;
        this.#log('planted clipboard sentinel');
      } catch (error) {
        this.#log(`sentinel write failed: ${(error as Error).message}`);
      }
      if (this.#active !== pending) return;
      try {
        this.#log(`opening signer app: ${pending.intent.slice(0, 80)}…`);
        this.#transport.open(pending.intent);
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
  }

  /**
   * Fail the active request (timeout, or `open()` throwing) and free the
   * signer. Abort is handled separately by {@link #cancelAll}, which tears
   * down the queue too.
   */
  #fail(pending: PendingRequest, error: unknown): void {
    this.#settle(pending);
    pending.reject(error);
  }

  /** Mark the active request finished, clear its timers, and pump the queue. */
  #settle(pending: PendingRequest): void {
    if (this.#active === pending) this.#active = null;
    this.#queue = this.#queue.filter((p) => p !== pending);
    this.#cleanup(pending);
    this.#pump();
  }

  /** Remove a request's timers and abort listener. Idempotent. */
  #cleanup(pending: PendingRequest): void {
    if (pending.poll) clearInterval(pending.poll);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.onAbort && this.#signal) {
      this.#signal.removeEventListener('abort', pending.onAbort);
    }
    pending.poll = null;
    pending.timer = null;
    pending.onAbort = null;
  }

  /** Reject everything live — the in-flight request and the queue behind it. */
  #cancelAll(): void {
    const active = this.#active;
    const queued = this.#queue;
    this.#active = null;
    this.#queue = [];
    for (const pending of active ? [active, ...queued] : queued) {
      this.#cleanup(pending);
      pending.reject(abortError());
    }
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
