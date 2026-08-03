import { generateSecretKey, nip19 } from "nostr-tools";

import { selfEncrypt, selfDecrypt } from "./nip44";

/**
 * View keys for private calendar events.
 *
 * A view key is a full secp256k1 secret key generated per event — never derived
 * from, and never equal to, the user's identity key. It is the read capability
 * for that event: it travels inside invitation gift wraps and inside the
 * owner's calendar-list refs.
 *
 * On the calendar-event wire it is always **nsec-encoded** (docs/protocol.md
 * §2). Do not "unify" this with other domains' encodings.
 */

export interface ViewKey {
  secretKey: Uint8Array;
  /** nip19 `nsec1…` encoding — the form that travels on the wire. */
  nsec: string;
}

export function generateViewKey(): ViewKey {
  const secretKey = generateSecretKey();
  return { secretKey, nsec: nip19.nsecEncode(secretKey) };
}

/**
 * Strict nsec → bytes. Rejects an npub/note/naddr rather than letting a wrong
 * key type reach NIP-44, where the failure surfaces much later as an
 * undecryptable event.
 */
export function decodeViewKey(nsec: string): Uint8Array {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error(`Expected an nsec view key, got ${decoded.type}`);
  }
  return decoded.data;
}

export function encodeViewKey(secretKey: Uint8Array): string {
  return nip19.nsecEncode(secretKey);
}

export function encryptWithViewKey(nsec: string, data: unknown): string {
  return selfEncrypt(decodeViewKey(nsec), data);
}

export function decryptWithViewKey<T>(nsec: string, ciphertext: string): T {
  return selfDecrypt<T>(decodeViewKey(nsec), ciphertext);
}
