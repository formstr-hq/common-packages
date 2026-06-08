import type { Event as NostrEvent, EventTemplate } from 'nostr-tools';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { StorageAdapter } from './storage.js';

export type LoginMethod = 'extension' | 'nip46' | 'ncryptsec' | 'android';

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

export type SignerEvent =
  | { type: 'login'; account: StoredAccount }
  | { type: 'logout'; pubkey: string }
  | { type: 'switch'; account: StoredAccount };

export interface SignerConfig {
  storage?: StorageAdapter;
  storageKeyPrefix?: string;
  appName?: string;
  appUrl?: string;
  /**
   * Default Android signer plugin (NIP-55). Provide the host app's
   * `nostr-signer-capacitor-plugin` instance or an equivalent stub.
   * Can be overridden per-call via `loginWithAndroidSigner({ plugin })`.
   */
  androidSignerPlugin?: import('../nip55.js').AndroidSignerPlugin;
}
