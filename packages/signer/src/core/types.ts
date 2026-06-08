import type { Event as NostrEvent, EventTemplate } from 'nostr-tools';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { StorageAdapter } from './storage.js';

/**
 * How the user's key material is held for an account:
 *  - `extension`: NIP-07 browser extension (window.nostr).
 *  - `nip46`: NIP-46 remote signer (bunker URI or nostrconnect QR).
 *  - `ncryptsec`: NIP-49 encrypted nsec — decrypted into memory on unlock.
 *  - `android`: NIP-55 Android external signer app via a Capacitor plugin.
 */
export type LoginMethod = 'extension' | 'nip46' | 'ncryptsec' | 'android';

/**
 * Serialized account record persisted by the {@link StorageAdapter}.
 *
 * Survives reloads. Re-hydrates as **locked** — the account is present in
 * `listAccounts()` and reachable via `getActiveAccount()`, but
 * `getActiveSigner()` returns `null` until the user re-authenticates
 * (passphrase for ncryptsec, page granted for extension, signer app for
 * NIP-46/NIP-55).
 *
 * Method-specific fields:
 *  - `ncryptsec` — present when `method === 'ncryptsec'`. The encrypted nsec.
 *  - `nip46` — present when `method === 'nip46'`. URI, remote signer pubkey,
 *     relays, and the per-account client session keypair (hex). The client
 *     secret key is stored in plaintext on purpose — see the README's
 *     threat-model note.
 *  - `androidPackageName` — present when `method === 'android'`. Identifies
 *     which installed signer app fulfilled the login (e.g. Amber).
 */
export interface StoredAccount {
  npub: string;
  pubkey: string;
  method: LoginMethod;
  ncryptsec?: string;
  nip46?: {
    uri: string;
    remoteSignerPubkey: string;
    relays: string[];
    clientSecretKey: string;
  };
  androidPackageName?: string;
}

/**
 * The runtime signing surface exposed once an account is **unlocked**.
 *
 * Every concrete signer ({@link LocalSigner}, {@link ExtensionSigner},
 * {@link BunkerSigner}, {@link AndroidSigner}) conforms to this. The
 * abstraction has one deliberate omission: there is no `getPrivateKey()`.
 * The raw secret key is never reachable through this interface — that is
 * the package's central security invariant. Local signing holds the key
 * in memory; the other methods sign remotely.
 *
 * `signEvent` accepts an unsigned {@link EventTemplate} (no `pubkey`,
 * `id`, or `sig`) and returns a fully-signed {@link NostrEvent} —
 * the implementation sets the `pubkey` to the active account's and fills
 * in `id`/`sig`.
 *
 * `nip04Encrypt`/`nip44Encrypt` and their decrypt counterparts perform
 * ECDH against `peerPubkey` (a 32-byte x-only hex pubkey). All four
 * may throw if the remote signer (extension / bunker / Android) denies
 * the operation.
 */
export interface ActiveSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}

export interface RelayMismatchInfo {
  userRelays: string[];
  bunkerRelays: string[];
}

/**
 * Called after pairing if the bunker's preferred relays (via get_relays)
 * differ from the user-supplied list. Return `true` to accept the bunker's
 * list — it will be stored on the account for future sessions. Return
 * `false` (or anything falsy) to keep the user's list. Either way, the
 * current in-memory session keeps using the user's relays since those
 * just worked for pairing.
 */
export type RelayMismatchHandler = (
  info: RelayMismatchInfo,
) => boolean | Promise<boolean>;

export interface BunkerLoginOptions {
  pool?: AbstractSimplePool;
  onAuth?: (url: string) => void;
  /** Reuse a stored client session keypair to resume a NIP-46 connection. */
  clientSecretKey?: Uint8Array;
  onRelayMismatch?: RelayMismatchHandler;
  /**
   * NIP-46 permissions to request as part of the `connect` call
   * (e.g. `['sign_event:1', 'nip44_encrypt']`). Without this, many
   * bunker UIs (e.g. Amber) show no approve/deny prompt because the
   * connect request has nothing concrete to authorize.
   */
  perms?: string[];
}

export interface NostrConnectOptions {
  relays: string[];
  metadata?: { name?: string; url?: string; image?: string };
  perms?: string[];
  /** Called once with the generated nostrconnect URI so the caller can render it. */
  onUri: (uri: string) => void;
  pool?: AbstractSimplePool;
  onAuth?: (url: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  onRelayMismatch?: RelayMismatchHandler;
}

/**
 * Emitted by {@link Signer.onChange}. Variants:
 *  - `login` — a new account became active (no previous active account).
 *  - `switch` — the active account changed (including unlocking an already
 *     hydrated account, since unlock re-asserts the active signer).
 *  - `logout` — `logout(pubkey)` removed an account; emitted with the
 *     removed account's `pubkey` (the account itself is already gone from
 *     `listAccounts()` by the time the event fires).
 */
export type SignerEvent =
  | { type: 'login'; account: StoredAccount }
  | { type: 'logout'; pubkey: string }
  | { type: 'switch'; account: StoredAccount };

export interface SignerConfig {
  /**
   * Persistence backend. Defaults to a `localStorage`-backed adapter.
   * Provide a custom adapter to use sessionStorage, an in-memory map,
   * IndexedDB, or any other key/value store. See {@link StorageAdapter}.
   */
  storage?: StorageAdapter;
  /** Prefix applied to all keys written by the default localStorage adapter. */
  storageKeyPrefix?: string;
  /**
   * Human-readable app name used as the default `name` metadata in
   * the nostrconnect:// URI generated by `loginWithNostrConnect`.
   * Remote signers (Amber, etc.) display this on the consent screen.
   * Overridden by a per-call `metadata.name`.
   */
  appName?: string;
  /**
   * Canonical app URL used as the default `url` metadata in the
   * nostrconnect:// URI. Overridden by a per-call `metadata.url`.
   */
  appUrl?: string;
  /**
   * Icon URL used as the default `image` metadata in the
   * nostrconnect:// URI. Overridden by a per-call `metadata.image`.
   */
  appImage?: string;
  /**
   * Default Android signer plugin (NIP-55). Provide the host app's
   * `nostr-signer-capacitor-plugin` instance or an equivalent stub that
   * satisfies {@link import('../nip55.js').AndroidSignerPlugin}.
   * Can be overridden per-call via `loginWithAndroidSigner({ plugin })`
   * or `listAndroidSignerApps(plugin)`.
   */
  androidSignerPlugin?: import('../nip55.js').AndroidSignerPlugin;
}
