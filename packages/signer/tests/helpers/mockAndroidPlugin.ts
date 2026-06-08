import { getPublicKey, nip19, type EventTemplate } from 'nostr-tools';
import { LocalSigner } from '../../src/core/localSigner.js';
import type { AndroidSignerPlugin } from '../../src/nip55.js';

/**
 * In-memory stand-in for `nostr-signer-capacitor-plugin`. Wraps a LocalSigner
 * so all NIP-55 operations are functionally equivalent to a real Android
 * external signer holding the user's key.
 */
export class MockAndroidPlugin implements AndroidSignerPlugin {
  readonly secretKey: Uint8Array;
  readonly npub: string;
  packageName: string | null = null;
  private readonly local: LocalSigner;

  constructor(secretKey: Uint8Array, defaultPackageName = 'com.mock.signer') {
    this.secretKey = secretKey;
    this.npub = nip19.npubEncode(getPublicKey(secretKey));
    this.local = new LocalSigner(secretKey);
    this.packageName = defaultPackageName;
  }

  async setPackageName(opts: { packageName: string }): Promise<unknown> {
    this.packageName = opts.packageName;
    return undefined;
  }

  async getPublicKey(): Promise<{ npub: string; package?: string }> {
    return { npub: this.npub, package: this.packageName ?? undefined };
  }

  async signEvent(opts: {
    eventJson: string;
    eventId: string;
    npub: string;
  }): Promise<{ signature: string; event: string }> {
    const template = JSON.parse(opts.eventJson) as EventTemplate & { pubkey?: string };
    const signed = await this.local.signEvent(template);
    return { signature: signed.sig, event: JSON.stringify(signed) };
  }

  async nip04Encrypt(opts: {
    plainText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }> {
    return { result: await this.local.nip04Encrypt(opts.pubKey, opts.plainText) };
  }

  async nip04Decrypt(opts: {
    encryptedText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }> {
    return { result: await this.local.nip04Decrypt(opts.pubKey, opts.encryptedText) };
  }

  async nip44Encrypt(opts: {
    plainText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }> {
    return { result: await this.local.nip44Encrypt(opts.pubKey, opts.plainText) };
  }

  async nip44Decrypt(opts: {
    encryptedText: string;
    npub: string;
    pubKey: string;
  }): Promise<{ result: string }> {
    return { result: await this.local.nip44Decrypt(opts.pubKey, opts.encryptedText) };
  }
}
