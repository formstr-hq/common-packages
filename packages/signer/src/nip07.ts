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

function isNostrProvider(provider: unknown): provider is WindowNostr {
  const nostr = provider as Partial<WindowNostr> | null | undefined;
  return typeof nostr?.getPublicKey === 'function' && typeof nostr?.signEvent === 'function';
}

/** Check capabilities without prompting the extension or requesting permissions. */
export function hasNostrExtension(): boolean {
  if (typeof window === 'undefined') return false;
  return isNostrProvider((window as { nostr?: unknown }).nostr);
}

/** Observe late injection, removal, and site-access changes until cleaned up. */
export function watchNostrExtension(onChange: (available: boolean) => void): () => void {
  let available = hasNostrExtension();
  onChange(available);
  if (typeof window === 'undefined') return () => {};
  const browser = window;
  const check = (): void => {
    const next = hasNostrExtension();
    if (next !== available) {
      available = next;
      onChange(next);
    }
  };
  const timer = browser.setInterval(check, 500);
  browser.addEventListener('focus', check);
  return () => {
    browser.clearInterval(timer);
    browser.removeEventListener('focus', check);
  };
}

export function getWindowNostr(): WindowNostr {
  // Preserve support for explicitly supplied global providers outside browsers.
  const nostr = typeof window === 'undefined'
    ? (globalThis as { nostr?: unknown }).nostr
    : (window as { nostr?: unknown }).nostr;
  if (!isNostrProvider(nostr)) {
    throw new Error(
      '@formstr/signer: NIP-07 extension unavailable. Install a NIP-07 extension or enable its access to the current website, then retry.',
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
