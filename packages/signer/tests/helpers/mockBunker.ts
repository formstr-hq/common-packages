import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip44,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import { LocalSigner } from '../../src/core/localSigner.js';
import type { MockPool } from './mockRelay.js';

const NOSTR_CONNECT_KIND = 24133;

export interface MockBunkerOptions {
  pool: MockPool;
  relays: string[];
  userSecretKey?: Uint8Array;
  bunkerSecretKey?: Uint8Array;
  /** Override the relay list returned by the get_relays RPC. Defaults to `relays`. */
  preferredRelays?: string[];
  /** If true, the get_relays RPC returns an error instead of a relay list. */
  failGetRelays?: boolean;
  /** Override the raw JSON string returned as the get_relays result. */
  getRelaysResultJson?: string;
}

interface Nip46Request {
  id: string;
  method: string;
  params: string[];
}

interface Nip46Response {
  id: string;
  result?: string;
  error?: string;
}

/**
 * Simulates a NIP-46 remote signer. Listens on the mock pool for kind-24133
 * events addressed to it, decrypts them, performs the requested operation
 * with a LocalSigner backed by `userSecretKey`, and publishes an encrypted
 * response signed by `bunkerSecretKey`.
 *
 * Also supports the nostrconnect flow via `scanNostrConnectURI`.
 */
export class MockBunker {
  readonly userSecretKey: Uint8Array;
  readonly userPubkey: string;
  readonly bunkerSecretKey: Uint8Array;
  readonly bunkerPubkey: string;
  readonly relays: string[];
  readonly preferredRelays: string[];
  readonly failGetRelays: boolean;
  readonly getRelaysResultJson: string | undefined;
  readonly pool: MockPool;
  /** Params (post-pubkey/secret) of the most recent `connect` request. */
  lastConnectParams: string[] | null = null;
  private readonly user: LocalSigner;
  private readonly convKeyCache = new Map<string, Uint8Array>();

  constructor(opts: MockBunkerOptions) {
    this.pool = opts.pool;
    this.relays = opts.relays;
    this.preferredRelays = opts.preferredRelays ?? opts.relays;
    this.failGetRelays = opts.failGetRelays ?? false;
    this.getRelaysResultJson = opts.getRelaysResultJson;
    this.userSecretKey = opts.userSecretKey ?? generateSecretKey();
    this.userPubkey = getPublicKey(this.userSecretKey);
    this.bunkerSecretKey = opts.bunkerSecretKey ?? generateSecretKey();
    this.bunkerPubkey = getPublicKey(this.bunkerSecretKey);
    this.user = new LocalSigner(this.userSecretKey);
    this.#start();
  }

  buildBunkerUri(secret?: string): string {
    const params = new URLSearchParams();
    for (const r of this.relays) params.append('relay', r);
    if (secret) params.append('secret', secret);
    return `bunker://${this.bunkerPubkey}?${params.toString()}`;
  }

  /** Simulate the bunker scanning a client-generated nostrconnect:// URI. */
  scanNostrConnectURI(uri: string): void {
    const stripped = uri.replace(/^nostrconnect:\/\//, '');
    const [clientPubkey, query = ''] = stripped.split('?');
    if (!clientPubkey) throw new Error('mock bunker: nostrconnect URI missing client pubkey');
    const params = new URLSearchParams(query);
    const secret = params.get('secret');
    if (!secret) throw new Error('mock bunker: nostrconnect URI missing secret');
    const relays = params.getAll('relay');
    const targetRelays = relays.length > 0 ? relays : this.relays;
    const convKey = this.#getConvKey(clientPubkey);
    const ciphertext = nip44.v2.encrypt(JSON.stringify({ result: secret }), convKey);
    const event = finalizeEvent(
      {
        kind: NOSTR_CONNECT_KIND,
        content: ciphertext,
        tags: [['p', clientPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.bunkerSecretKey,
    );
    this.pool.publish(targetRelays, event);
  }

  #getConvKey(peerPubkey: string): Uint8Array {
    let key = this.convKeyCache.get(peerPubkey);
    if (!key) {
      key = nip44.v2.utils.getConversationKey(this.bunkerSecretKey, peerPubkey);
      this.convKeyCache.set(peerPubkey, key);
    }
    return key;
  }

  #start(): void {
    this.pool.subscribe(
      this.relays,
      { kinds: [NOSTR_CONNECT_KIND], '#p': [this.bunkerPubkey] },
      {
        onevent: (event) => {
          this.#handleEvent(event).catch(() => {});
        },
      },
    );
  }

  async #handleEvent(event: NostrEvent): Promise<void> {
    const clientPubkey = event.pubkey;
    const convKey = this.#getConvKey(clientPubkey);
    let request: Nip46Request;
    try {
      request = JSON.parse(nip44.v2.decrypt(event.content, convKey)) as Nip46Request;
    } catch {
      return;
    }
    const response = await this.#processRequest(request);
    const ciphertext = nip44.v2.encrypt(JSON.stringify(response), convKey);
    const replyEvent = finalizeEvent(
      {
        kind: NOSTR_CONNECT_KIND,
        content: ciphertext,
        tags: [['p', clientPubkey]],
        created_at: Math.floor(Date.now() / 1000),
      },
      this.bunkerSecretKey,
    );
    this.pool.publish(this.relays, replyEvent);
  }

  async #processRequest(request: Nip46Request): Promise<Nip46Response> {
    try {
      switch (request.method) {
        case 'connect':
          this.lastConnectParams = request.params;
          return { id: request.id, result: 'ack' };
        case 'ping':
          return { id: request.id, result: 'pong' };
        case 'get_public_key':
          return { id: request.id, result: this.userPubkey };
        case 'get_relays': {
          if (this.failGetRelays) {
            return { id: request.id, error: 'get_relays not supported' };
          }
          if (this.getRelaysResultJson !== undefined) {
            return { id: request.id, result: this.getRelaysResultJson };
          }
          const map: Record<string, { read: boolean; write: boolean }> = {};
          for (const r of this.preferredRelays) {
            map[r] = { read: true, write: true };
          }
          return { id: request.id, result: JSON.stringify(map) };
        }
        case 'sign_event': {
          const template = JSON.parse(request.params[0]) as EventTemplate;
          const signed = await this.user.signEvent(template);
          return { id: request.id, result: JSON.stringify(signed) };
        }
        case 'nip04_encrypt': {
          const [peer, plain] = request.params;
          return { id: request.id, result: await this.user.nip04Encrypt(peer, plain) };
        }
        case 'nip04_decrypt': {
          const [peer, ct] = request.params;
          return { id: request.id, result: await this.user.nip04Decrypt(peer, ct) };
        }
        case 'nip44_encrypt': {
          const [peer, plain] = request.params;
          return { id: request.id, result: await this.user.nip44Encrypt(peer, plain) };
        }
        case 'nip44_decrypt': {
          const [peer, ct] = request.params;
          return { id: request.id, result: await this.user.nip44Decrypt(peer, ct) };
        }
        default:
          return { id: request.id, error: `unknown method: ${request.method}` };
      }
    } catch (e) {
      return { id: request.id, error: (e as Error).message };
    }
  }
}
