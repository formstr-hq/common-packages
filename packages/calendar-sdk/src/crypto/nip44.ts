import { getPublicKey } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";

/**
 * "Conversation key with a raw secret key you hold" — idiom (a) of
 * docs/protocol.md §2.
 *
 * The caller already has the secret key bytes (a generated view key); no signer
 * and no login are involved. NIP-44 encrypts to a conversation key derived from
 * that key and its OWN public key, so anyone holding the key can read.
 *
 * Mirrors `selfEncrypt`/`selfDecrypt` in nostr-calendar's `src/nostr/crypto.ts`.
 * Callers decode their own key material first — the encoding differs by domain
 * (nsec for calendar events, raw hex for scheduling pages) and that distinction
 * must NOT be normalized away.
 */
export function selfEncrypt(secretKey: Uint8Array, data: unknown): string {
  const publicKey = getPublicKey(secretKey);
  return encrypt(JSON.stringify(data), getConversationKey(secretKey, publicKey));
}

export function selfDecrypt<T>(secretKey: Uint8Array, content: string): T {
  const publicKey = getPublicKey(secretKey);
  return JSON.parse(decrypt(content, getConversationKey(secretKey, publicKey))) as T;
}
