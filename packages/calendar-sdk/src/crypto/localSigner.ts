import { finalizeEvent, getPublicKey, nip19 } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

import type { CalendarSigner } from "../contracts";

/**
 * A `CalendarSigner` backed by a raw secret key held in memory.
 *
 * Intended for tests, scripts and server-side agents. In a browser, prefer a
 * NIP-07 extension or a NIP-46 bunker through `@formstr/signer` — a key in
 * page memory is a key in every XSS's memory.
 */
export class LocalSigner implements CalendarSigner {
  private readonly secretKey: Uint8Array;
  private readonly pubkey: string;

  constructor(secretKey: Uint8Array | string) {
    this.secretKey =
      typeof secretKey === "string" ? LocalSigner.decodeSecretKey(secretKey) : secretKey;
    this.pubkey = getPublicKey(this.secretKey);
  }

  private static decodeSecretKey(key: string): Uint8Array {
    if (key.startsWith("nsec")) {
      const decoded = nip19.decode(key);
      if (decoded.type !== "nsec") throw new Error(`Expected an nsec, got ${decoded.type}`);
      return decoded.data;
    }
    if (!/^[0-9a-f]{64}$/i.test(key)) {
      throw new Error("Expected a 64-character hex secret key or an nsec");
    }
    return Uint8Array.from(key.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(event: EventTemplate): Promise<Event> {
    return finalizeEvent(event, this.secretKey);
  }

  async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
    return encrypt(plaintext, getConversationKey(this.secretKey, pubkey));
  }

  async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
    return decrypt(ciphertext, getConversationKey(this.secretKey, pubkey));
  }
}
