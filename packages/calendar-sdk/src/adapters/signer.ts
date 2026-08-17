import type { CalendarSigner } from "../contracts";

/**
 * Structural signers (`@formstr/signer`'s `ActiveSigner`, a NIP-07 extension,
 * anything else with the same four methods) into a `CalendarSigner`.
 *
 * The binding is the point. Class-based signers keep state on `this`, so a bare
 * method reference (`{ signEvent: signer.signEvent }`) loses it and fails at
 * call time with an unhelpful "cannot read property of undefined". This wraps
 * every method in an arrow that keeps the receiver.
 */
export function toCalendarSigner(signer: {
  getPublicKey(): Promise<string> | string;
  signEvent(event: never): Promise<never> | never;
  nip44Encrypt?(pubkey: string, plaintext: string): Promise<string> | string;
  nip44Decrypt?(pubkey: string, ciphertext: string): Promise<string> | string;
}): CalendarSigner {
  return {
    getPublicKey: async () => signer.getPublicKey(),
    signEvent: async (event) => (signer.signEvent as (e: unknown) => never)(event),
    nip44Encrypt: async (pubkey, plaintext) => {
      if (!signer.nip44Encrypt) {
        throw new Error("Signer cannot NIP-44 encrypt — private calendar objects need it");
      }
      return signer.nip44Encrypt(pubkey, plaintext);
    },
    nip44Decrypt: async (pubkey, ciphertext) => {
      if (!signer.nip44Decrypt) {
        throw new Error("Signer cannot NIP-44 decrypt — private calendar objects need it");
      }
      return signer.nip44Decrypt(pubkey, ciphertext);
    },
  };
}
