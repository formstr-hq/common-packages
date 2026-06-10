import { generateSecretKey, getPublicKey } from 'nostr-tools';
import {
  BunkerSigner as ToolsBunkerSigner,
  createNostrConnectURI,
  parseBunkerInput,
  type BunkerPointer,
} from 'nostr-tools/nip46';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools';
import type { ActiveSigner, RelayMismatchHandler } from './core/types.js';

export type { BunkerPointer };

/**
 * Thin wrapper around nostr-tools' BunkerSigner that exposes only the
 * ActiveSigner surface. We keep this layer so callers depend on a stable
 * interface even if we ever swap the underlying implementation.
 *
 * Optionally accepts a `cachedUserPubkey`. When supplied, {@link getPublicKey}
 * returns it without a bunker roundtrip. The user's signer pubkey is fixed
 * for a given paired account, so caching it after the initial `connect` —
 * or feeding it back in from persisted storage on unlock — avoids both a
 * network hop and a potential approval prompt on every cold start. Without
 * a cached value we fall back to asking the bunker, matching the prior
 * behavior.
 */
export class BunkerSigner implements ActiveSigner {
  readonly #delegate: ToolsBunkerSigner;
  readonly #cachedUserPubkey: string | null;

  constructor(delegate: ToolsBunkerSigner, cachedUserPubkey?: string) {
    this.#delegate = delegate;
    this.#cachedUserPubkey = cachedUserPubkey ?? null;
  }

  getPublicKey(): Promise<string> {
    if (this.#cachedUserPubkey !== null) {
      return Promise.resolve(this.#cachedUserPubkey);
    }
    return this.#delegate.getPublicKey();
  }
  signEvent(event: EventTemplate): Promise<NostrEvent> {
    return this.#delegate.signEvent(event);
  }
  nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return this.#delegate.nip04Encrypt(peerPubkey, plaintext);
  }
  nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.#delegate.nip04Decrypt(peerPubkey, ciphertext);
  }
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return this.#delegate.nip44Encrypt(peerPubkey, plaintext);
  }
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return this.#delegate.nip44Decrypt(peerPubkey, ciphertext);
  }
  async close(): Promise<void> {
    return this.#delegate.close();
  }
}

export interface BunkerLoginOptions {
  /** Custom pool, e.g. for tests. Defaults to a new SimplePool inside nostr-tools. */
  pool?: AbstractSimplePool;
  /** Called when the remote signer needs the user to visit an auth URL. */
  onAuth?: (url: string) => void;
  /** Optional client session keypair (hex bytes). Auto-generated if omitted. */
  clientSecretKey?: Uint8Array;
  /** Notified when the bunker's preferred relays differ from the URI's. */
  onRelayMismatch?: RelayMismatchHandler;
  /**
   * NIP-46 permissions to request as the 3rd `connect` param
   * (e.g. `['sign_event:1', 'nip44_encrypt']`). When omitted, the
   * connect request carries no perms — bunker UIs may then skip the
   * approval prompt entirely, leaving the user with nothing to tap.
   */
  perms?: string[];
}

async function fetchBunkerRelays(tools: ToolsBunkerSigner): Promise<string[] | null> {
  try {
    const resp = await tools.sendRequest('get_relays', []);
    const parsed = JSON.parse(resp) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((r): r is string => typeof r === 'string');
    }
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.keys(parsed as Record<string, unknown>);
    }
    return null;
  } catch {
    return null;
  }
}

function relayListsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return false;
  return true;
}

async function resolveRelayChoice(
  tools: ToolsBunkerSigner,
  userRelays: string[],
  onRelayMismatch: RelayMismatchHandler | undefined,
): Promise<string[]> {
  if (!onRelayMismatch) return userRelays;
  const bunkerRelays = await fetchBunkerRelays(tools);
  if (!bunkerRelays || relayListsMatch(userRelays, bunkerRelays)) return userRelays;
  const accept = await onRelayMismatch({ userRelays, bunkerRelays });
  return accept ? bunkerRelays : userRelays;
}

export interface BunkerConnectResult {
  signer: BunkerSigner;
  pubkey: string;
  pointer: BunkerPointer;
  clientSecretKey: Uint8Array;
}

/**
 * Connect to a remote signer via a bunker:// URI (or a NIP-05 identifier).
 * Relays come from the URI — there is no fallback default list.
 */
export async function connectWithBunkerUri(
  uri: string,
  options: BunkerLoginOptions = {},
): Promise<BunkerConnectResult> {
  const pointer = await parseBunkerInput(uri);
  if (!pointer) {
    throw new Error('@formstr/signer: invalid bunker URI');
  }
  if (!pointer.relays?.length) {
    throw new Error('@formstr/signer: bunker URI must include at least one relay');
  }
  const clientSecretKey = options.clientSecretKey ?? generateSecretKey();
  const tools = ToolsBunkerSigner.fromBunker(clientSecretKey, pointer, {
    pool: options.pool,
    onauth: options.onAuth,
  });
  // nostr-tools' BunkerSigner.connect() hardcodes only [pubkey, secret],
  // dropping the optional 3rd `perms` arg defined by NIP-46. Without it
  // bunker UIs (Amber, etc.) have no permissions to authorize and may
  // skip the approval prompt entirely. We send the request directly.
  await tools.sendRequest('connect', [
    pointer.pubkey,
    pointer.secret ?? '',
    (options.perms ?? []).join(','),
  ]);
  const pubkey = await tools.getPublicKey();
  const resolvedRelays = await resolveRelayChoice(
    tools,
    pointer.relays,
    options.onRelayMismatch,
  );
  return {
    signer: new BunkerSigner(tools, pubkey),
    pubkey,
    pointer: { ...pointer, relays: resolvedRelays },
    clientSecretKey,
  };
}

export interface NostrConnectInitOptions {
  /** User-supplied relays. The whole point of the strict-relay rule. */
  relays: string[];
  metadata?: { name?: string; url?: string; image?: string };
  /** Permissions to request (NIP-46 perms list, e.g. ["sign_event:1","nip44_encrypt"]). */
  perms?: string[];
  pool?: AbstractSimplePool;
  onAuth?: (url: string) => void;
  /** Override the auto-generated client session keypair. */
  clientSecretKey?: Uint8Array;
  /** Override the auto-generated URI secret. */
  secret?: string;
  /** Abort the pairing wait. */
  signal?: AbortSignal;
  /** Max wait for pairing in ms (default 5 minutes). */
  timeoutMs?: number;
  /** Notified when the bunker's preferred relays differ from the user's. */
  onRelayMismatch?: RelayMismatchHandler;
}

export interface NostrConnectInitiation {
  uri: string;
  clientPubkey: string;
  complete: Promise<BunkerConnectResult>;
}

/**
 * Generate a nostrconnect:// URI and wait for the remote signer to pair.
 * The caller displays the URI (typically as a QR code), and the returned
 * `complete` promise resolves once the signer connects back.
 */
export function initiateNostrConnect(options: NostrConnectInitOptions): NostrConnectInitiation {
  if (options.relays.length === 0) {
    throw new Error('@formstr/signer: at least one relay is required for nostrconnect');
  }
  const clientSecretKey = options.clientSecretKey ?? generateSecretKey();
  const clientPubkey = getPublicKey(clientSecretKey);
  const secret = options.secret ?? Math.random().toString(36).slice(2);
  const uri = createNostrConnectURI({
    clientPubkey,
    relays: options.relays,
    secret,
    perms: options.perms,
    name: options.metadata?.name,
    url: options.metadata?.url,
    image: options.metadata?.image,
  });
  const maxWaitOrAbort: number | AbortSignal =
    options.signal ?? options.timeoutMs ?? 300_000;
  // skipSwitchRelays:true — keep the caller-supplied relays authoritative,
  // never silently swap to whatever the bunker prefers.
  const complete = ToolsBunkerSigner.fromURI(
    clientSecretKey,
    uri,
    { pool: options.pool, onauth: options.onAuth, skipSwitchRelays: true },
    maxWaitOrAbort,
  ).then(async (tools) => {
    const pubkey = await tools.getPublicKey();
    const resolvedRelays = await resolveRelayChoice(
      tools,
      options.relays,
      options.onRelayMismatch,
    );
    return {
      signer: new BunkerSigner(tools, pubkey),
      pubkey,
      pointer: { ...tools.bp, relays: resolvedRelays },
      clientSecretKey,
    };
  });
  return { uri, clientPubkey, complete };
}

const hexAlphabet = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += hexAlphabet[b >> 4] + hexAlphabet[b & 0xf];
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hexToBytes: odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
