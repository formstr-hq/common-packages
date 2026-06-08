import { getPublicKey, nip19 } from 'nostr-tools';
import type {
  ActiveSigner,
  BunkerLoginOptions,
  NostrConnectOptions,
  SignerConfig,
  SignerEvent,
  StoredAccount,
} from './types.js';
import { localStorageAdapter, type StorageAdapter } from './storage.js';
import { LocalSigner } from './localSigner.js';
import { decryptNcryptsec, generateAccount } from '../nip49.js';
import { ExtensionSigner } from '../nip07.js';
import { bytesToHex, connectWithBunkerUri, initiateNostrConnect } from '../nip46.js';
import {
  loginWithAndroidSigner as connectWithAndroidSigner,
  type AndroidLoginOptions,
  type AndroidSignerAppInfo,
  type AndroidSignerPlugin,
} from '../nip55.js';

const ACCOUNTS_KEY = 'accounts';
const ACTIVE_KEY = 'active-pubkey';

export class Signer {
  readonly #storage: StorageAdapter;
  readonly #defaultAndroidPlugin: AndroidSignerPlugin | undefined;
  #accounts: StoredAccount[] = [];
  #activePubkey: string | null = null;
  #activeSigner: ActiveSigner | null = null;
  #listeners = new Set<(event: SignerEvent) => void>();

  constructor(config: SignerConfig = {}) {
    this.#storage = config.storage ?? localStorageAdapter(config.storageKeyPrefix);
    this.#defaultAndroidPlugin = config.androidSignerPlugin;
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

  async createAccount(passphrase: string): Promise<{ npub: string; ncryptsec: string }> {
    if (!passphrase) throw new Error('createAccount: passphrase required');
    const { secretKey, pubkey, npub, ncryptsec } = generateAccount(passphrase);
    const account: StoredAccount = { npub, pubkey, method: 'ncryptsec', ncryptsec };
    this.#upsertAccount(account);
    this.#setActive(account, new LocalSigner(secretKey));
    return { npub, ncryptsec };
  }

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

  async loginWithExtension(): Promise<StoredAccount> {
    const extension = new ExtensionSigner();
    const pubkey = await extension.getPublicKey();
    const npub = nip19.npubEncode(pubkey);
    const account: StoredAccount = { npub, pubkey, method: 'extension' };
    this.#upsertAccount(account);
    this.#setActive(account, extension);
    return account;
  }

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

  async loginWithNostrConnect(options: NostrConnectOptions): Promise<StoredAccount> {
    if (options.relays.length === 0) {
      throw new Error('loginWithNostrConnect: at least one relay required');
    }
    const init = initiateNostrConnect({
      relays: options.relays,
      metadata: options.metadata,
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

  listAccounts(): StoredAccount[] {
    return [...this.#accounts];
  }

  getActiveAccount(): StoredAccount | null {
    if (!this.#activePubkey) return null;
    return this.#accounts.find(a => a.pubkey === this.#activePubkey) ?? null;
  }

  getActiveSigner(): ActiveSigner | null {
    return this.#activeSigner;
  }

  async switchAccount(pubkey: string): Promise<void> {
    const account = this.#accounts.find(a => a.pubkey === pubkey);
    if (!account) throw new Error(`switchAccount: no account for pubkey ${pubkey}`);
    this.#activePubkey = pubkey;
    this.#activeSigner = null;
    this.#persistActive();
    this.#emit({ type: 'switch', account });
  }

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

  onChange(cb: (event: SignerEvent) => void): () => void {
    this.#listeners.add(cb);
    return () => {
      this.#listeners.delete(cb);
    };
  }
}

export function createSigner(config: SignerConfig = {}): Signer {
  return new Signer(config);
}
