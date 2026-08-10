import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";

import { LocalSigner } from "./localSigner";
import { nip44SelfDecrypt, nip44SelfEncrypt } from "./nip44";

/**
 * Per-BOARD view key (doc 05 §1). A private board's payload is encrypted with a
 * freshly generated secret key under its OWN pubkey, so anyone holding the nsec
 * reconstructs the conversation key and decrypts. Unlike self-encryption to an
 * identity key, that makes the payload shareable.
 *
 * One key per board, not per card: a board is the unit of access, and per-card
 * keys would turn the board into a key store rewritten on every card creation.
 * The cost is blast radius — one leaked key exposes the board's whole history
 * (doc 07 §D5).
 */

export interface ViewKey {
  /** Bech32 `nsec…` — the shareable form stored in board-list refs. */
  nsec: string;
  /** Hex public key derived from the secret. Never published; the blinded pointer needs it. */
  pubkey: string;
  /** Raw secret bytes. */
  secret: Uint8Array;
}

export function generateViewKey(): ViewKey {
  const secret = generateSecretKey();
  return { secret, nsec: nip19.nsecEncode(secret), pubkey: getPublicKey(secret) };
}

export function viewKeyFromNsec(nsec: string): ViewKey {
  const decoded = nip19.decode(nsec);
  if (decoded.type !== "nsec") {
    throw new Error(`Expected an nsec view key, got ${decoded.type}`);
  }
  const secret = decoded.data;
  return { secret, nsec, pubkey: getPublicKey(secret) };
}

function signerFromNsec(nsec: string): LocalSigner {
  return new LocalSigner(viewKeyFromNsec(nsec).secret);
}

export async function encryptWithViewKey(nsec: string, plaintext: string): Promise<string> {
  return nip44SelfEncrypt(signerFromNsec(nsec), plaintext);
}

export async function decryptWithViewKey(nsec: string, ciphertext: string): Promise<string> {
  return nip44SelfDecrypt(signerFromNsec(nsec), ciphertext);
}
