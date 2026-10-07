import type { Event, EventTemplate } from "nostr-tools";

/**
 * Minimal signing/encryption surface mailstr-sdk needs from a host signer.
 *
 * The secret-key entry points (`unwrapMail`, `readInbox`, `sendMail`, …) are
 * ideal when your app owns a dedicated mail identity's key. This interface is
 * the alternative for hosts that never expose a private key — browser
 * extensions (NIP-07), remote signers (NIP-46), and the MCP's keystore-backed
 * signer. Both `@formstr/core`'s `NostrSigner` and `@formstr/signer`'s
 * `ActiveSigner` satisfy it structurally.
 *
 * The identity behind the signer IS the mail identity: mailstr's bridge
 * authorizes a sender by matching the seal's pubkey against the NIP-05 record
 * for the From address, so the account you sign with must be the account the
 * `name@domain` address is bound to.
 */
export interface MailSigner {
  /** Hex x-only pubkey of the signing identity. */
  getPublicKey(): Promise<string>;
  /** NIP-44 encrypt to `pubkey`. */
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  /** NIP-44 decrypt from `pubkey`. */
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
  /** Sign a NIP-01 event template, returning the finalized event. */
  signEvent(event: EventTemplate): Promise<Event>;
}
