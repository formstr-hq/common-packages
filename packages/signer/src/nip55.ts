import { getEventHash, nip19, type Event as NostrEvent, type EventTemplate } from 'nostr-tools';
import type { ActiveSigner } from './core/types.js';

/**
 * Subset of `nostr-signer-capacitor-plugin`'s exported `NostrSignerPlugin`
 * that we depend on. Signatures intentionally mirror that library
 * (positional args, per-call `packageName`) so the real plugin is
 * structurally assignable here — and any mock written against this
 * interface is a faithful stand-in. The conformance is enforced by a
 * compile-time guard in `tests/helpers/mockAndroidPlugin.ts`.
 */
export interface AndroidSignerAppInfo {
  name: string;
  packageName: string;
  iconUrl?: string;
}

export interface AndroidSignerPlugin {
  setPackageName(packageName: string): Promise<void>;
  getInstalledSignerApps(): Promise<{ apps: AndroidSignerAppInfo[] }>;
  getPublicKey(
    packageName?: string,
    permissions?: string,
  ): Promise<{ npub: string; package: string }>;
  signEvent(
    packageName: string,
    eventJson: string,
    id: string,
    npub: string,
  ): Promise<{ signature: string; id: string; event: string }>;
  nip04Encrypt(
    packageName: string,
    plainText: string,
    id: string,
    pubKey: string,
    npub: string,
  ): Promise<{ result: string; id: string }>;
  nip04Decrypt(
    packageName: string,
    encryptedText: string,
    id: string,
    pubKey: string,
    npub: string,
  ): Promise<{ result: string; id: string }>;
  nip44Encrypt(
    packageName: string,
    plainText: string,
    id: string,
    pubKey: string,
    npub: string,
  ): Promise<{ result: string; id: string }>;
  nip44Decrypt(
    packageName: string,
    encryptedText: string,
    id: string,
    pubKey: string,
    npub: string,
  ): Promise<{ result: string; id: string }>;
}

export interface AndroidLoginOptions {
  /** The Android package name of the external signer app (e.g. com.greenart7c3.nostrsigner). */
  packageName?: string;
  /** Override the plugin for this call. Falls back to SignerConfig.androidSignerPlugin. */
  plugin?: AndroidSignerPlugin;
}

export class AndroidSigner implements ActiveSigner {
  readonly #plugin: AndroidSignerPlugin;
  readonly #packageName: string;
  readonly #npub: string;
  readonly #pubkey: string;

  constructor(
    plugin: AndroidSignerPlugin,
    packageName: string,
    npub: string,
    pubkey: string,
  ) {
    this.#plugin = plugin;
    this.#packageName = packageName;
    this.#npub = npub;
    this.#pubkey = pubkey;
  }

  async getPublicKey(): Promise<string> {
    return this.#pubkey;
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    const unsigned = { ...event, pubkey: this.#pubkey };
    const eventId = getEventHash(unsigned);
    const result = await this.#plugin.signEvent(
      this.#packageName,
      JSON.stringify(unsigned),
      eventId,
      this.#npub,
    );
    return JSON.parse(result.event) as NostrEvent;
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const { result } = await this.#plugin.nip04Encrypt(
      this.#packageName,
      plaintext,
      '',
      peerPubkey,
      this.#npub,
    );
    return result;
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const { result } = await this.#plugin.nip04Decrypt(
      this.#packageName,
      ciphertext,
      '',
      peerPubkey,
      this.#npub,
    );
    return result;
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const { result } = await this.#plugin.nip44Encrypt(
      this.#packageName,
      plaintext,
      '',
      peerPubkey,
      this.#npub,
    );
    return result;
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const { result } = await this.#plugin.nip44Decrypt(
      this.#packageName,
      ciphertext,
      '',
      peerPubkey,
      this.#npub,
    );
    return result;
  }
}

export interface AndroidLoginResult {
  signer: AndroidSigner;
  pubkey: string;
  npub: string;
  packageName: string;
}

/**
 * Render a debuggable summary of what the Android signer plugin returned
 * where an npub was expected. Includes type and length, plus a truncated
 * prefix that preserves the bech32 HRP (so callers can tell `nsec1…` /
 * `nprofile1…` / a raw hex pubkey apart) without leaking the full secret
 * material that an erroneous `nsec` response would carry.
 */
function describeIdentifier(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value !== 'string') {
    return `<${typeof value}>`;
  }
  if (value.length === 0) return 'empty string';
  const prefix = value.slice(0, 12);
  const suffix = value.length > 12 ? '…' : '';
  return `"${prefix}${suffix}" (length=${value.length})`;
}

/**
 * Lowercase 32-byte hex pubkey shape. NIP-55 nominally returns an `npub`
 * in the `signature` extra, but recent Amber builds put the raw hex
 * pubkey there instead — we accept either form and normalize internally.
 */
const HEX_PUBKEY_RE = /^[0-9a-f]{64}$/i;

export async function loginWithAndroidSigner(
  plugin: AndroidSignerPlugin,
  packageName?: string,
): Promise<AndroidLoginResult> {
  if (packageName) {
    await plugin.setPackageName(packageName);
  }
  const { npub: rawIdentifier, package: pluginPackage } =
    await plugin.getPublicKey(packageName);
  const resolvedPackage = pluginPackage || packageName;
  if (!resolvedPackage) {
    throw new Error(
      '@formstr/signer: android signer did not return a package name and none was supplied',
    );
  }
  const { pubkey, npub } = normalizeAndroidIdentifier(rawIdentifier);
  return {
    signer: new AndroidSigner(plugin, resolvedPackage, npub, pubkey),
    pubkey,
    npub,
    packageName: resolvedPackage,
  };
}

/**
 * Normalize whatever the Android signer plugin handed us in the `npub`
 * slot into a `{ pubkey, npub }` pair. Accepts either:
 *   - a 32-byte lowercase hex pubkey (newer Amber builds return this),
 *   - a bech32 `npub1…` (the original NIP-55 spec shape).
 * Throws a debuggable error for anything else, including the preview
 * of what was actually received so the caller can triage.
 */
function normalizeAndroidIdentifier(
  rawIdentifier: unknown,
): { pubkey: string; npub: string } {
  if (typeof rawIdentifier === 'string' && HEX_PUBKEY_RE.test(rawIdentifier)) {
    const pubkey = rawIdentifier.toLowerCase();
    return { pubkey, npub: nip19.npubEncode(pubkey) };
  }
  // Wrap nip19.decode so a bech32 failure ("Data must be at least 6
  // characters long", "Invalid checksum", ...) surfaces what the plugin
  // actually returned. Without this, callers see an opaque bech32 crash
  // and can't tell whether Amber sent back an empty string, an nsec, or
  // something else entirely.
  let decoded: ReturnType<typeof nip19.decode>;
  try {
    decoded = nip19.decode(rawIdentifier as string);
  } catch (e) {
    // nostr-tools' nip19 decoder always throws Error instances on bech32
    // failures ("Data must be at least 6 characters long", "Invalid
    // checksum", "Unknown prefix", ...). Pass the message straight through.
    throw new Error(
      `@formstr/signer: android signer returned an undecodable identifier (got ${describeIdentifier(rawIdentifier)}): ${(e as Error).message}`,
    );
  }
  if (decoded.type !== 'npub') {
    throw new Error(
      `@formstr/signer: android signer returned a non-npub identifier (type=${decoded.type}, got ${describeIdentifier(rawIdentifier)})`,
    );
  }
  return { pubkey: decoded.data, npub: rawIdentifier as string };
}
