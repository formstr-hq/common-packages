import {
  finalizeEvent,
  getPublicKey,
  nip04,
  nip44,
  type Event as NostrEvent,
  type EventTemplate,
} from 'nostr-tools';
import type { ActiveSigner } from './types.js';

/**
 * ActiveSigner backed by a raw secret key held in memory.
 * The secret key never leaves this object — there is no getter for it.
 */
export class LocalSigner implements ActiveSigner {
  readonly #secretKey: Uint8Array;

  constructor(secretKey: Uint8Array) {
    this.#secretKey = secretKey;
  }

  async getPublicKey(): Promise<string> {
    return getPublicKey(this.#secretKey);
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    return finalizeEvent(event, this.#secretKey);
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    return nip04.encrypt(this.#secretKey, peerPubkey, plaintext);
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    return nip04.decrypt(this.#secretKey, peerPubkey, ciphertext);
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const key = nip44.v2.utils.getConversationKey(this.#secretKey, peerPubkey);
    return nip44.v2.encrypt(plaintext, key);
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const key = nip44.v2.utils.getConversationKey(this.#secretKey, peerPubkey);
    return nip44.v2.decrypt(ciphertext, key);
  }
}
