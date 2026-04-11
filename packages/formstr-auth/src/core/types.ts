import { Event, EventTemplate } from "nostr-tools";

export interface NostrSigner {
  getPublicKey: () => Promise<string>;
  signEvent: (event: EventTemplate) => Promise<Event>;
  encrypt?: (pubkey: string, plaintext: string) => Promise<string>;
  decrypt?: (pubkey: string, ciphertext: string) => Promise<string>;
  nip44Encrypt?: (pubkey: string, txt: string) => Promise<string>;
  nip44Decrypt?: (pubkey: string, ct: string) => Promise<string>;
  getRelays?: () => Promise<string[]>;
}

export interface IUser {
  pubkey: string;
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  lud16?: string;
}
