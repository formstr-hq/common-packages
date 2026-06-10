import { getPublicKey, nip19 } from 'nostr-tools';
import { BunkerSigner as ToolsBunkerSigner } from 'nostr-tools/nip46';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type {
  ActiveSigner,
  BunkerLoginOptions,
  NostrConnectOptions,
  SignerConfig,
  SignerEvent,
  StoredAccount,
  UnlockOptions,
} from './types.js';
import { localStorageAdapter, type StorageAdapter } from './storage.js';
import { LocalSigner } from './localSigner.js';
import { decryptNcryptsec, generateAccount } from '../nip49.js';
import { ExtensionSigner } from '../nip07.js';
import {
  BunkerSigner,
  bytesToHex,
  connectWithBunkerUri,
  hexToBytes,
  initiateNostrConnect,
} from '../nip46.js';
import {
  AndroidSigner,
  loginWithAndroidSigner as connectWithAndroidSigner,
  type AndroidLoginOptions,
  type AndroidSignerAppInfo,
  type AndroidSignerPlugin,
} from '../nip55.js';

const ACCOUNTS_KEY = 'accounts';
const ACTIVE_KEY = 'active-pubkey';

/**
 * Multi-account Nostr signer with persistence.
 *
 * **Hydration.** The constructor reads previously-saved accounts from
 * the configured storage adapter. Every hydrated account starts
 * **locked**: present in `listAccounts()` and (if it was the active one
 * before) reachable via `getActiveAccount()`, but `getActiveSigner()`
 * returns `null` until the user re-authenticates. The matching
 * `loginWith*` method unlocks the active account.
 *
 * **Locked vs unlocked.** Use `getActiveAccount()` to render UI ("logged
 * in as @alice") and `getActiveSigner()` to decide whether the user can
 * actually sign. The pattern is "show the account always, gate signing
 * on the signer."
 *
 * **Events.** Subscribe via `onChange()` to re-render when an account
 * is added, switched, or removed. See {@link SignerEvent}.
 */
export class Signer {
  readonly #storage: StorageAdapter;
  readonly #defaultAndroidPlugin: AndroidSignerPlugin | undefined;
  readonly #appMetadata: { name?: string; url?: string; image?: string };
  #accounts: StoredAccount[] = [];
  #activePubkey: string | null = null;
  #activeSigner: ActiveSigner | null = null;
  #listeners = new Set<(event: SignerEvent) => void>();

  constructor(config: SignerConfig = {}) {
    this.#storage = config.storage ?? localStorageAdapter(config.storageKeyPrefix);
    this.#defaultAndroidPlugin = config.androidSignerPlugin;
    this.#appMetadata = {
      name: config.appName,
      url: config.appUrl,
      image: config.appImage,
    };
    this.#hydrate();
  }

  #hydrate(): void {
    try {
      const raw = this.#storage.get(ACCOUNTS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) this.#accounts = parsed as StoredAccount[];
      }
      this.#activePubkey = this.#storage.get(ACTIVE_KEY);
    } catch {
      this.#accounts = [];
      this.#activePubkey = null;
    }
  }

  #persistAccounts(): void {
    this.#storage.set(ACCOUNTS_KEY, JSON.stringify(this.#accounts));
  }

  #persistActive(): void {
    if (this.#activePubkey) this.#storage.set(ACTIVE_KEY, this.#activePubkey);
    else this.#storage.remove(ACTIVE_KEY);
  }

  #upsertAccount(account: StoredAccount): void {
    const idx = this.#accounts.findIndex(a => a.pubkey === account.pubkey);
    if (idx >= 0) this.#accounts[idx] = account;
    else this.#accounts.push(account);
    this.#persistAccounts();
  }

  #setActive(account: StoredAccount, signer: ActiveSigner): void {
    const wasDifferent = this.#activePubkey !== null && this.#activePubkey !== account.pubkey;
    this.#activePubkey = account.pubkey;
    this.#activeSigner = signer;
    this.#persistActive();
    this.#emit({ type: wasDifferent ? 'switch' : 'login', account });
  }

  #emit(event: SignerEvent): void {
    for (const cb of this.#listeners) {
      try {
        cb(event);
      } catch {
        // listener errors are swallowed so one bad listener can't break others
      }
    }
  }

  /**
   * Generate a brand-new nsec, encrypt it with `passphrase` (NIP-49),
   * persist the resulting `ncryptsec` account, and activate it. Returns
   * the new account's `npub` and `ncryptsec` — the caller must surface
   * the `ncryptsec` to the user **immediately** since it is the only way
   * back into the account on a fresh device.
   *
   * @throws if `passphrase` is empty.
   */
  async createAccount(passphrase: string): Promise<{ npub: string; ncryptsec: string }> {
    if (!passphrase) throw new Error('createAccount: passphrase required');
    const { secretKey, pubkey, npub, ncryptsec } = generateAccount(passphrase);
    const account: StoredAccount = { npub, pubkey, method: 'ncryptsec', ncryptsec };
    this.#upsertAccount(account);
    this.#setActive(account, new LocalSigner(secretKey));
    return { npub, ncryptsec };
  }

  /**
   * Decrypt an ncryptsec with the user's passphrase, persist the account
   * (overwriting any previous entry for the same pubkey), and activate it.
   *
   * @throws if either argument is empty, or if the passphrase doesn't
   * decrypt the ncryptsec.
   */
  async loginWithNcryptsec(ncryptsec: string, passphrase: string): Promise<StoredAccount> {
    if (!ncryptsec) throw new Error('loginWithNcryptsec: ncryptsec required');
    if (!passphrase) throw new Error('loginWithNcryptsec: passphrase required');
    const secretKey = decryptNcryptsec(ncryptsec, passphrase);
    const pubkey = getPublicKey(secretKey);
    const npub = nip19.npubEncode(pubkey);
    const account: StoredAccount = { npub, pubkey, method: 'ncryptsec', ncryptsec };
    this.#upsertAccount(account);
    this.#setActive(account, new LocalSigner(secretKey));
    return account;
  }

  /**
   * Connect via the NIP-07 browser extension exposed at `window.nostr`.
   * The extension prompts the user for permission on first use.
   *
   * @throws if no extension is installed or the user denies the request.
   */
  async loginWithExtension(): Promise<StoredAccount> {
    const extension = new ExtensionSigner();
    const pubkey = await extension.getPublicKey();
    const npub = nip19.npubEncode(pubkey);
    const account: StoredAccount = { npub, pubkey, method: 'extension' };
    this.#upsertAccount(account);
    this.#setActive(account, extension);
    return account;
  }

  /**
   * Connect to a NIP-46 remote signer via a `bunker://` URI. Relays are
   * read from the URI itself — no hardcoded fallbacks. Pass a `pool`
   * to reuse an existing relay connection; pass `clientSecretKey` to
   * resume a previous session (the hex from `StoredAccount.nip46`).
   *
   * @throws if the URI is malformed, no relay is reachable, or the
   * remote signer rejects pairing within the implementation's timeout.
   */
  async loginWithBunkerUri(
    uri: string,
    options: BunkerLoginOptions = {},
  ): Promise<StoredAccount> {
    const result = await connectWithBunkerUri(uri, options);
    const npub = nip19.npubEncode(result.pubkey);
    const account: StoredAccount = {
      npub,
      pubkey: result.pubkey,
      method: 'nip46',
      nip46: {
        uri,
        remoteSignerPubkey: result.pointer.pubkey,
        relays: result.pointer.relays,
        clientSecretKey: bytesToHex(result.clientSecretKey),
      },
    };
    this.#upsertAccount(account);
    this.#setActive(account, result.signer);
    return account;
  }

  /**
   * Initiate a NIP-46 `nostrconnect://` pairing. Generates a client
   * keypair, publishes a connect request to the supplied `relays`, and
   * waits for a remote signer to pair. Call `options.onUri(uri)` to
   * render the URI as a QR code; the returned promise resolves once
   * pairing completes. Cancel by aborting `options.signal`.
   *
   * @throws if `relays` is empty, the user aborts, the pairing times
   * out, or no signer responds.
   */
  async loginWithNostrConnect(options: NostrConnectOptions): Promise<StoredAccount> {
    if (options.relays.length === 0) {
      throw new Error('loginWithNostrConnect: at least one relay required');
    }
    // Merge per-call metadata over SignerConfig defaults (appName/url/image).
    // `name` is required — Amber (and likely other NIP-55 signer apps) gate
    // the consent UI on having a recognizable client identity in the URI.
    // Without one they will receive the request but never surface
    // approve/deny buttons, leaving the pairing silently stuck.
    const metadata = {
      name: options.metadata?.name ?? this.#appMetadata.name,
      url: options.metadata?.url ?? this.#appMetadata.url,
      image: options.metadata?.image ?? this.#appMetadata.image,
    };
    if (!metadata.name) {
      throw new Error(
        '@formstr/signer: loginWithNostrConnect requires an app name. Set `appName` in createSigner() or pass `metadata.name` to loginWithNostrConnect().',
      );
    }
    const init = initiateNostrConnect({
      relays: options.relays,
      metadata,
      perms: options.perms,
      pool: options.pool,
      onAuth: options.onAuth,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      onRelayMismatch: options.onRelayMismatch,
    });
    options.onUri(init.uri);
    const result = await init.complete;
    const npub = nip19.npubEncode(result.pubkey);
    const account: StoredAccount = {
      npub,
      pubkey: result.pubkey,
      method: 'nip46',
      nip46: {
        uri: init.uri,
        remoteSignerPubkey: result.pointer.pubkey,
        relays: result.pointer.relays,
        clientSecretKey: bytesToHex(result.clientSecretKey),
      },
    };
    this.#upsertAccount(account);
    this.#setActive(account, result.signer);
    return account;
  }

  /**
   * Enumerate NIP-55 signer apps installed on the device, via the
   * configured Android plugin (or `plugin` if supplied). Useful for
   * rendering a "pick your signer" list — the built-in UI does this
   * automatically when the Android tab is selected.
   *
   * Only meaningful inside a Capacitor Android shell. On web/iOS the
   * configured plugin is typically absent and this throws.
   *
   * @throws if no plugin is configured and none is passed in.
   */
  async listAndroidSignerApps(
    plugin?: AndroidSignerPlugin,
  ): Promise<AndroidSignerAppInfo[]> {
    const p = plugin ?? this.#defaultAndroidPlugin;
    if (!p) {
      throw new Error(
        '@formstr/signer: no Android signer plugin configured (pass `androidSignerPlugin` to createSigner or `plugin` to listAndroidSignerApps)',
      );
    }
    const { apps } = await p.getInstalledSignerApps();
    return apps;
  }

  /**
   * Sign in via a NIP-55 Android external signer (Amber, etc). If
   * `options.packageName` is given, that specific signer app is invoked;
   * otherwise the plugin picks a default (typically the only installed
   * signer, or an OS chooser). Pass `options.plugin` to override the
   * configured default for this call.
   *
   * @throws if no plugin is configured, the signer app cannot be
   * resolved to a package name, or the user denies the request.
   */
  async loginWithAndroidSigner(options: AndroidLoginOptions = {}): Promise<StoredAccount> {
    const plugin = options.plugin ?? this.#defaultAndroidPlugin;
    if (!plugin) {
      throw new Error(
        '@formstr/signer: no Android signer plugin configured (pass `androidSignerPlugin` to createSigner or `plugin` to loginWithAndroidSigner)',
      );
    }
    const result = await connectWithAndroidSigner(plugin, options.packageName);
    const account: StoredAccount = {
      npub: result.npub,
      pubkey: result.pubkey,
      method: 'android',
      androidPackageName: result.packageName,
    };
    this.#upsertAccount(account);
    this.#setActive(account, result.signer);
    return account;
  }

  /** Snapshot of every persisted account, in insertion order. */
  listAccounts(): StoredAccount[] {
    return [...this.#accounts];
  }

  /**
   * The currently selected account, or `null` if none. Present even when
   * the account is locked (no active signer yet). Use this to render
   * "logged in as @alice" — pair with {@link getActiveSigner} to decide
   * whether signing is actually available.
   */
  getActiveAccount(): StoredAccount | null {
    if (!this.#activePubkey) return null;
    return this.#accounts.find(a => a.pubkey === this.#activePubkey) ?? null;
  }

  /**
   * The unlocked signer for the active account, or `null` if locked.
   * After a fresh page load this is `null` for every account type
   * (passphrase / extension grant / signer-app handshake all need to
   * be redone). Calling the matching `loginWith*` method unlocks it.
   */
  getActiveSigner(): ActiveSigner | null {
    return this.#activeSigner;
  }

  /**
   * Silently unlock the active account from persisted state — no user
   * prompt, no fresh pairing. The package already keeps everything it
   * needs to reconstruct the runtime signer on disk; this method is the
   * way to actually use that on cold start instead of re-running each
   * method's first-time login flow.
   *
   * Behavior by method:
   *
   *  - `extension`: constructs an {@link ExtensionSigner}, which just
   *    proxies to `window.nostr`. No setup roundtrip — individual
   *    operations may still prompt depending on the extension's own
   *    permission state, but unlock itself does not.
   *
   *  - `nip46`: reuses the stored `clientSecretKey` to construct a
   *    {@link BunkerSigner} against the stored bunker pubkey + relays
   *    via `BunkerSigner.fromBunker`. Deliberately skips the `connect`
   *    request — the remote signer (Amber etc.) approved this client
   *    pubkey on first pairing and re-sending `connect` is what surfaces
   *    a fresh approval prompt every cold start. Requires `options.pool`
   *    so the BunkerSigner has somewhere to listen for responses.
   *    The cached user pubkey is fed into the wrapper so a follow-up
   *    `getPublicKey()` is a memory read, not a relay request.
   *
   *  - `android`: constructs an {@link AndroidSigner} directly from the
   *    stored `androidPackageName` + `pubkey` + `npub`. Skips the
   *    `getPublicKey` content-provider roundtrip that
   *    {@link loginWithAndroidSigner} performs and that — on Amber —
   *    surfaces as a permission prompt every cold start.
   *
   *  - `ncryptsec`: returns `null`. There is no silent path — the user's
   *    passphrase isn't (and shouldn't be) persisted. The caller must
   *    drive the passphrase prompt and call {@link loginWithNcryptsec}.
   *
   * Returns `null` (without emitting any event or mutating state) when
   * there is no active account, when the account is missing fields
   * required to unlock, when `nip46` is the method but no `pool` was
   * supplied, or when `android` is the method but no plugin is
   * configured. On success emits the same `login` / `switch` event the
   * corresponding `loginWith*` would.
   */
  async unlock(options: UnlockOptions = {}): Promise<ActiveSigner | null> {
    const account = this.getActiveAccount();
    if (!account) return null;

    switch (account.method) {
      case 'extension': {
        const signer = new ExtensionSigner();
        this.#setActive(account, signer);
        return signer;
      }

      case 'nip46': {
        if (!account.nip46) return null;
        if (!options.pool) return null;
        const { remoteSignerPubkey, relays, clientSecretKey } = account.nip46;
        if (!remoteSignerPubkey || !relays.length || !clientSecretKey) {
          return null;
        }
        const tools = ToolsBunkerSigner.fromBunker(
          hexToBytes(clientSecretKey),
          { pubkey: remoteSignerPubkey, relays, secret: null },
          { pool: options.pool },
        );
        // No tools.connect() — the bunker already approved this client
        // on first pairing; re-sending `connect` is what triggers the
        // cold-start approval prompt we are trying to avoid.
        const signer = new BunkerSigner(tools, account.pubkey);
        this.#setActive(account, signer);
        return signer;
      }

      case 'android': {
        if (!account.androidPackageName) return null;
        if (!this.#defaultAndroidPlugin) return null;
        const signer = new AndroidSigner(
          this.#defaultAndroidPlugin,
          account.androidPackageName,
          account.npub,
          account.pubkey,
        );
        this.#setActive(account, signer);
        return signer;
      }

      case 'ncryptsec':
        // No silent path — passphrase is not (and must not be) persisted.
        return null;
    }
  }

  /**
   * Make `pubkey` the active account. Clears the in-memory signer —
   * the new account starts **locked** even if it was previously
   * unlocked in this session.
   *
   * @throws if `pubkey` does not match any persisted account.
   */
  async switchAccount(pubkey: string): Promise<void> {
    const account = this.#accounts.find(a => a.pubkey === pubkey);
    if (!account) throw new Error(`switchAccount: no account for pubkey ${pubkey}`);
    this.#activePubkey = pubkey;
    this.#activeSigner = null;
    this.#persistActive();
    this.#emit({ type: 'switch', account });
  }

  /**
   * Remove an account from storage. `pubkey` defaults to the active
   * account. If the active account is removed, the in-memory signer is
   * cleared. No-op if there is nothing to remove.
   */
  async logout(pubkey?: string): Promise<void> {
    const target = pubkey ?? this.#activePubkey;
    if (!target) return;
    this.#accounts = this.#accounts.filter(a => a.pubkey !== target);
    this.#persistAccounts();
    if (this.#activePubkey === target) {
      this.#activePubkey = null;
      this.#activeSigner = null;
      this.#persistActive();
    }
    this.#emit({ type: 'logout', pubkey: target });
  }

  /**
   * Subscribe to account-state changes. Returns an unsubscribe function.
   * Listener errors are swallowed so one bad listener can't break others.
   * See {@link SignerEvent} for the variants.
   */
  onChange(cb: (event: SignerEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }
}

/** Convenience wrapper around `new Signer(config)`. */
export function createSigner(config: SignerConfig = {}): Signer {
  return new Signer(config);
}
