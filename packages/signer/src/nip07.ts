import type { Event as NostrEvent, EventTemplate } from 'nostr-tools';
import type { ActiveSigner } from './core/types.js';

export interface WindowNostr {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>;
  nip04?: {
    encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  };
  nip44?: {
    encrypt(peerPubkey: string, plaintext: string): Promise<string>;
    decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  };
}

export function getWindowNostr(): WindowNostr {
  const nostr = (globalThis as { nostr?: WindowNostr }).nostr;
  if (!nostr) {
    throw new Error(
      '@formstr/signer: NIP-07 extension not found (globalThis.nostr is undefined)',
    );
  }
  return nostr;
}

export class ExtensionSigner implements ActiveSigner {
  async getPublicKey(): Promise<string> {
    return getWindowNostr().getPublicKey();
  }

  async signEvent(event: EventTemplate): Promise<NostrEvent> {
    return getWindowNostr().signEvent(event);
  }

  async nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const ext = getWindowNostr();
    if (!ext.nip04) throw new Error('NIP-07 extension does not expose nip04');
    return ext.nip04.encrypt(peerPubkey, plaintext);
  }

  async nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const ext = getWindowNostr();
    if (!ext.nip04) throw new Error('NIP-07 extension does not expose nip04');
    return ext.nip04.decrypt(peerPubkey, ciphertext);
  }

  async nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string> {
    const ext = getWindowNostr();
    if (!ext.nip44) throw new Error('NIP-07 extension does not expose nip44');
    return ext.nip44.encrypt(peerPubkey, plaintext);
  }

  async nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string> {
    const ext = getWindowNostr();
    if (!ext.nip44) throw new Error('NIP-07 extension does not expose nip44');
    return ext.nip44.decrypt(peerPubkey, ciphertext);
  }
}
