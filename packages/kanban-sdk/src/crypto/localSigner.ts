import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

import type { KanbanSigner } from "../contracts";

/**
 * In-memory secret-key signer. Backs the view-key crypto — a view key IS a
 * LocalSigner over a throwaway key — and doubles as a convenience KanbanSigner
 * for hosts holding a raw nsec.
 */
export class LocalSigner implements KanbanSigner {
  private secretKey: Uint8Array;
  private pubkey: string;

  constructor(secretKey?: Uint8Array) {
    this.secretKey = secretKey ?? generateSecretKey();
    this.pubkey = getPublicKey(this.secretKey);
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(event: EventTemplate): Promise<Event> {
    return finalizeEvent(event, this.secretKey);
  }

  async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
    return nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(this.secretKey, pubkey));
  }

  async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    return nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(this.secretKey, pubkey));
  }

  getSecretKey(): Uint8Array {
    return this.secretKey;
  }

  /** Zero the in-memory secret. Subsequent operations fail. */
  dispose(): void {
    this.secretKey.fill(0);
  }
}
