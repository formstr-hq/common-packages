import { getPublicKey, nip19, type EventTemplate } from 'nostr-tools';
import type { NostrSignerPlugin as RealNostrSignerPlugin } from 'nostr-signer-capacitor-plugin';
import { LocalSigner } from '../../src/core/localSigner.js';
import type { AndroidSignerPlugin } from '../../src/nip55.js';

/**
 * In-memory stand-in for `nostr-signer-capacitor-plugin`. Wraps a LocalSigner
 * so all NIP-55 operations are functionally equivalent to a real Android
 * external signer holding the user's key.
 *
 * The compile-time guard at the bottom of this file ensures the real plugin
 * remains structurally assignable to AndroidSignerPlugin — if it ever stops,
 * fix the interface in src/nip55.ts (and this mock) rather than papering
 * over the divergence here.
 */
export class MockAndroidPlugin implements AndroidSignerPlugin {
  readonly secretKey: Uint8Array;
  readonly npub: string;
  packageName: string;
  private readonly local: LocalSigner;

  constructor(secretKey: Uint8Array, defaultPackageName = 'com.mock.signer') {
    this.secretKey = secretKey;
    this.npub = nip19.npubEncode(getPublicKey(secretKey));
    this.local = new LocalSigner(secretKey);
    this.packageName = defaultPackageName;
  }

  async setPackageName(packageName: string): Promise<void> {
    this.packageName = packageName;
  }

  async getInstalledSignerApps(): Promise<{
    apps: Array<{ name: string; packageName: string; iconUrl?: string }>;
  }> {
    return {
      apps: [
        { name: 'Mock Signer', packageName: this.packageName },
      ],
    };
  }

  async getPublicKey(
    _packageName?: string,
    _permissions?: string,
  ): Promise<{ npub: string; package: string }> {
    return { npub: this.npub, package: this.packageName };
  }

  async signEvent(
    _packageName: string,
    eventJson: string,
    id: string,
    _npub: string,
  ): Promise<{ signature: string; id: string; event: string }> {
    const template = JSON.parse(eventJson) as EventTemplate & { pubkey?: string };
    const signed = await this.local.signEvent(template);
    return { signature: signed.sig, id, event: JSON.stringify(signed) };
  }

  async nip04Encrypt(
    _packageName: string,
    plainText: string,
    id: string,
    pubKey: string,
    _npub: string,
  ): Promise<{ result: string; id: string }> {
    return { result: await this.local.nip04Encrypt(pubKey, plainText), id };
  }

  async nip04Decrypt(
    _packageName: string,
    encryptedText: string,
    id: string,
    pubKey: string,
    _npub: string,
  ): Promise<{ result: string; id: string }> {
    return { result: await this.local.nip04Decrypt(pubKey, encryptedText), id };
  }

  async nip44Encrypt(
    _packageName: string,
    plainText: string,
    id: string,
    pubKey: string,
    _npub: string,
  ): Promise<{ result: string; id: string }> {
    return { result: await this.local.nip44Encrypt(pubKey, plainText), id };
  }

  async nip44Decrypt(
    _packageName: string,
    encryptedText: string,
    id: string,
    pubKey: string,
    _npub: string,
  ): Promise<{ result: string; id: string }> {
    return { result: await this.local.nip44Decrypt(pubKey, encryptedText), id };
  }
}

// Compile-time guard: the published `NostrSignerPlugin` from
// `nostr-signer-capacitor-plugin` must remain assignable to our
// `AndroidSignerPlugin`. If this line fails to type-check, the real
// plugin's API changed — update src/nip55.ts (and MockAndroidPlugin)
// to match. Type-only import: no runtime dependency on @capacitor/core.
const _realPluginConformanceGuard: AndroidSignerPlugin =
  null as unknown as typeof RealNostrSignerPlugin;
void _realPluginConformanceGuard;
