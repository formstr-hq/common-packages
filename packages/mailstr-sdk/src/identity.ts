import { generateSecretKey, getPublicKey, nip19 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import type { MailstrIdentity } from "./types.js";

/**
 * Derive a fresh mailstr identity: a dedicated secp256k1 keypair for mail
 * (kept separate from identity/profile keys by convention, so mail access is
 * revocable independently).
 *
 * The SDK deliberately does NOT persist anything — apps own storage. Persist
 * `secretKeyHex` yourself if you need to restore the identity later
 * (`identityFromSecretKey`), and never expose the secret in logs.
 */
export function createIdentity(): MailstrIdentity {
  const secretKey = generateSecretKey();
  return identityFromSecretKey(secretKey);
}

/**
 * Restore a `MailstrIdentity` from a stored secret key (raw bytes or hex).
 * The public facts (`pubkey`, `npub`) are derived, never stored blindly.
 */
export function identityFromSecretKey(secretKey: Uint8Array | string): MailstrIdentity {
  const key =
    typeof secretKey === "string"
      ? hexKeyToBytes(secretKey)
      : normalizeSecretKey(secretKey);
  const pubkey = getPublicKey(key);
  return {
    secretKey: key,
    secretKeyHex: bytesToHex(key),
    pubkey,
    npub: nip19.npubEncode(pubkey),
  };
}

function normalizeSecretKey(key: Uint8Array): Uint8Array {
  if (key.length !== 32) {
    throw new Error(`secret key must be 32 bytes, got ${key.length}`);
  }
  // Copy so callers can safely mutate their own buffer afterwards.
  return new Uint8Array(key);
}

function hexKeyToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("secret key hex must be 64 hex chars");
  }
  return hexToBytes(hex);
}