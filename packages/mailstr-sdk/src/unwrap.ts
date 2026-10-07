import { nip44, type Event } from "nostr-tools";
import type { MailSigner } from "./signer.js";
import type { UnwrapResult } from "./types.js";
import {
  parseRumor,
  parseSeal,
  verifySealAndRumor,
  unwrapWith,
  type UnwrapCoreOptions,
} from "./unwrap-core.js";

/**
 * Unwrap a NIP-59 gift wrap locally with a secret key, applying the same
 * verification rules as nail's `unwrapAndVerify`
 * (`nail/nostr-bridge/src/protocol/mail.ts`). Synchronous: the SDK owns the
 * identity key, so NIP-44 decrypt replaces the remote-signer abstraction and
 * nail's distinct `signer-error` state cannot occur.
 *
 * For hosts that never expose a private key (NIP-07/NIP-46, the MCP keystore),
 * use {@link unwrapMailWith} instead. Rules are documented on
 * {@link verifySealAndRumor}.
 */
export function unwrapMail(
  wrap: Event,
  secretKey: Uint8Array,
  opts: UnwrapCoreOptions = {},
): UnwrapResult {
  // Failure here is routine: relays hand us every wrap p-tagged to us, and
  // most are not ours to decrypt.
  const conversationKey = (pubkey: string) =>
    nip44.v2.utils.getConversationKey(secretKey, pubkey);

  let sealPlaintext: string;
  try {
    sealPlaintext = nip44.v2.decrypt(wrap.content, conversationKey(wrap.pubkey));
  } catch {
    return { ok: false, reason: "not-for-us" };
  }
  const parsedSeal = parseSeal(sealPlaintext);
  if (!parsedSeal.ok) return parsedSeal;
  const seal = parsedSeal.seal;
  // Decryption succeeded, so this wrap genuinely was addressed to us — a
  // non-JSON or malformed result past this point is broken/hostile input,
  // not routine traffic, and must be reported rather than swallowed.
  if (typeof seal.kind !== "number" || typeof seal.pubkey !== "string") {
    return { ok: false, reason: "malformed-seal" };
  }

  let rumorPlaintext: string;
  try {
    rumorPlaintext = nip44.v2.decrypt(seal.content, conversationKey(seal.pubkey));
  } catch {
    return { ok: false, reason: "malformed-rumor" };
  }
  const parsedRumor = parseRumor(rumorPlaintext);
  if (!parsedRumor.ok) return parsedRumor;

  return verifySealAndRumor(wrap, seal, parsedRumor.rumor, opts);
}

/**
 * Unwrap a gift wrap through a {@link MailSigner} instead of a raw secret key —
 * the path for NIP-07/NIP-46 and the MCP. Identical rules to {@link unwrapMail};
 * a signer that refuses or times out on the outer decrypt surfaces as the
 * routine `not-for-us`, since the SDK cannot distinguish that from a wrap
 * encrypted to someone else.
 */
export async function unwrapMailWith(
  wrap: Event,
  signer: MailSigner,
  opts: UnwrapCoreOptions = {},
): Promise<UnwrapResult> {
  return unwrapWith(wrap, (pubkey, ciphertext) => signer.nip44Decrypt(pubkey, ciphertext), opts);
}
