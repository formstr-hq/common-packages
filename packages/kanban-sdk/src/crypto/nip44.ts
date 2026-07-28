import type { KanbanSigner } from "../contracts";

/**
 * NIP-44 v2 wrappers over the signer.
 *
 * Self-encryption (encrypting to your OWN pubkey) is what makes the board list
 * (32303) private on a public relay: only the holder of the identity key can
 * derive the self-conversation key. Board and card payloads do NOT use this —
 * they are encrypted under the board view key so every member can read them
 * without a signer round trip (doc 07 §D3).
 */

export async function nip44Encrypt(
  signer: KanbanSigner,
  recipientPubkey: string,
  plaintext: string,
): Promise<string> {
  return signer.nip44Encrypt(recipientPubkey, plaintext);
}

export async function nip44Decrypt(
  signer: KanbanSigner,
  senderPubkey: string,
  ciphertext: string,
): Promise<string> {
  return signer.nip44Decrypt(senderPubkey, ciphertext);
}

export async function nip44SelfEncrypt(signer: KanbanSigner, plaintext: string): Promise<string> {
  return nip44Encrypt(signer, await signer.getPublicKey(), plaintext);
}

export async function nip44SelfDecrypt(signer: KanbanSigner, ciphertext: string): Promise<string> {
  return nip44Decrypt(signer, await signer.getPublicKey(), ciphertext);
}
