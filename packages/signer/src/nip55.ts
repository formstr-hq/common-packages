import { getEventHash, nip19, type Event as NostrEvent, type EventTemplate } from 'nostr-tools';
import type { ActiveSigner } from './core/types.js';

/**
 * The subset of the Capacitor `nostr-signer-capacitor-plugin` API that we
 * use. Callers can wire up the real plugin, or any equivalent object that
 * satisfies this interface.
 */
export interface AndroidSignerPlugin {
  setPackageName(opts: { packageName: string }): Promise<unknown>;
  getPublicKey(opts?: { permissions?: string }): Promise<{ npub: string; package?: string }>;
  signEvent(opts: {
    eventJson: string;
    eventId: string;
    npub: string;
  }): Promise<{ signature: string; event: string }>;
  nip04Encrypt(opts: {
    plainText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }>;
  nip04Decrypt(opts: {
    encryptedText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }>;
  nip44Encrypt(opts: {
    plainText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }>;
  nip44Decrypt(opts: {
    encryptedText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }>;
}

export interface AndroidLoginOptions {
  /** The Android package name of the external signer app (e.g. com.greenart7c3.nostrsigner). */
  packageName?: string;
  /** Override the plugin for this call. Falls back to SignerConfig.androidSignerPlugin. */
  plugin?: AndroidSignerPlugin;
}

export class AndroidSigner implements ActiveSigner {
  readonly #plugin: AndroidSignerPlugin;
  readonly #npub: string;
  readonly #pubkey: string;

  constructor(plugin: AndroidSignerPlugin, npub: string, pubkey: string) {
    this.#plugin = plugin;
    this.#npub = npub;
    this.#pubkey = pubkey;
  }

  async getPublicKey(): Promise<string> {
    return this.#pubkey;
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    const unsigned = { ...event, pubkey: this.#pubkey };
    const eventId = getEventHash(unsigned);
    const result = await this.#plugin.signEvent({
      eventJson: JSON.stringify(unsigned),
      eventId,
      npub: this.#npub,
    });
    return JSON.parse(result.event) as NostrEvent;
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const { result } = await this.#plugin.nip04Encrypt({
      plainText: plaintext,
      npub: this.#npub,
      pubKey: peerPubkey,
    });
    return result;
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const { result } = await this.#plugin.nip04Decrypt({
      encryptedText: ciphertext,
      npub: this.#npub,
      pubKey: peerPubkey,
    });
    return result;
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const { result } = await this.#plugin.nip44Encrypt({
      plainText: plaintext,
      npub: this.#npub,
      pubKey: peerPubkey,
    });
    return result;
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const { result } = await this.#plugin.nip44Decrypt({
      encryptedText: ciphertext,
      npub: this.#npub,
      pubKey: peerPubkey,
    });
    return result;
  }
}

export interface AndroidLoginResult {
  signer: AndroidSigner;
  pubkey: string;
  npub: string;
  packageName: string | null;
}

export async function loginWithAndroidSigner(
  plugin: AndroidSignerPlugin,
  packageName?: string,
): Promise<AndroidLoginResult> {
  if (packageName) {
    await plugin.setPackageName({ packageName });
  }
  const { npub, package: pluginPackage } = await plugin.getPublicKey();
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub') {
    throw new Error('@formstr/signer: android signer returned a non-npub identifier');
  }
  return {
    signer: new AndroidSigner(plugin, npub, decoded.data),
    pubkey: decoded.data,
    npub,
    packageName: pluginPackage ?? packageName ?? null,
  };
}
