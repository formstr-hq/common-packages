import { getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { hexToBytes } from "nostr-tools/utils";
import { KIND_MAIL, KIND_SEAL, MAX_RUMOR_AGE_SECONDS, WRAP_KEY_TAG } from "./constants.js";
import type { Rumor, UnwrapFailure, UnwrapResult } from "./types.js";

/** Per-call verification options shared by the secret-key and signer paths. */
export interface UnwrapCoreOptions {
  maxAgeSeconds?: number;
  now?: number;
  acceptKinds?: number[];
}

/**
 * NIP-59 gift-wrap verification, shared by the secret-key and signer unwrap
 * paths. Deliberately does NOT use nostr-tools' `unwrapEvent`: that helper
 * discards the seal and never checks `rumor.pubkey` against `seal.pubkey`,
 * which makes sender spoofing trivial for anything that authorizes on the rumor.
 *
 * The rule set (nail nostr-bridge §4), in spec order:
 *   1. seal signature verifies,
 *   2. seal kind is `KIND_SEAL`,
 *   3. rumor author equals seal author — the check nostr-tools omits,
 *   4. rumor kind is in `acceptKinds`,
 *   5. the rumor is not stale (`now - created_at` within `maxAgeSeconds`),
 *   6. if the rumor carries a `WRAP_KEY_TAG`, it must derive to the wrap's
 *      pubkey, or the embedded deletion key is a lie.
 */
export function verifySealAndRumor(
  wrap: Event,
  seal: Event,
  rumor: Rumor,
  opts: UnwrapCoreOptions = {},
): UnwrapResult {
  const maxAge = opts.maxAgeSeconds ?? MAX_RUMOR_AGE_SECONDS;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  // Which inner kinds this caller accepts. Defaults to mailstr mail only, so
  // NIP-17 DM rumors (kind 14) and other NIP-59 traffic surface as
  // `wrong-rumor-kind` instead of silently passing as mail.
  const acceptKinds = opts.acceptKinds ?? [KIND_MAIL];

  if (typeof seal.kind !== "number" || typeof seal.pubkey !== "string") {
    return { ok: false, reason: "malformed-seal" };
  }
  if (!verifyEvent(seal)) return { ok: false, reason: "bad-seal-signature" };
  if (seal.kind !== KIND_SEAL) return { ok: false, reason: "wrong-seal-kind" };

  if (rumor.pubkey !== seal.pubkey) return { ok: false, reason: "author-mismatch" };
  if (!acceptKinds.includes(rumor.kind)) return { ok: false, reason: "wrong-rumor-kind" };
  if (now - rumor.created_at > maxAge) return { ok: false, reason: "expired" };

  // A sender that embeds WRAP_KEY_TAG hands us the wrap author's signing key
  // for NIP-09 deletion. If that key does not derive to the wrap's pubkey the
  // rumor is lying, and every deletion signed with it would fail silently at
  // the relay — reject the wrap now, while the lie is attributable.
  const wrapSecret = rumor.tags.find(
    (t) => t[0] === WRAP_KEY_TAG && typeof t[1] === "string",
  )?.[1];
  if (wrapSecret !== undefined) {
    let valid = false;
    try {
      valid =
        /^[0-9a-f]{64}$/.test(wrapSecret) && getPublicKey(hexToBytes(wrapSecret)) === wrap.pubkey;
    } catch {
      valid = false; // not a parseable secret key at all
    }
    if (!valid) return { ok: false, reason: "wrapkey-mismatch" };
  }

  return { ok: true, seal, rumor, wrapSecret };
}

/** Parse a decrypted seal. Non-JSON / non-object / missing kind+pubkey → `malformed-seal`. */
export function parseSeal(
  plaintext: string,
): { ok: true; seal: Event } | { ok: false; reason: UnwrapFailure } {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "malformed-seal" };
    }
    return { ok: true, seal: parsed as Event };
  } catch {
    return { ok: false, reason: "malformed-seal" };
  }
}

/** Parse a decrypted rumor, enforcing the six-field shape. */
export function parseRumor(
  plaintext: string,
): { ok: true; rumor: Rumor } | { ok: false; reason: UnwrapFailure } {
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (!isValidRumorShape(parsed)) return { ok: false, reason: "malformed-rumor" };
    return { ok: true, rumor: parsed };
  } catch {
    return { ok: false, reason: "malformed-rumor" };
  }
}

/**
 * Structural check for the six fields `Rumor` requires. A rumor that fails
 * this can't be trusted downstream: `tags` is assumed to be an array of string
 * arrays, and the staleness check assumes `created_at` is a number — wrong
 * shapes would either crash or silently bypass the replay check (`now -
 * undefined` is `NaN`, and `NaN > maxAge` is always false). Mirrors
 * nostr-tools' own `validateEvent` tag check.
 */
export function isValidRumorShape(value: unknown): value is Rumor {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.kind === "number" &&
    typeof r.pubkey === "string" &&
    typeof r.created_at === "number" &&
    Array.isArray(r.tags) &&
    r.tags.every((tag) => Array.isArray(tag) && tag.every((el) => typeof el === "string")) &&
    typeof r.content === "string"
  );
}

/**
 * Async unwrap over an arbitrary decrypt function — the signer path. Only I/O
 * is `decrypt(pubkey, ciphertext)`; the wrap author is read from `wrap.pubkey`.
 */
export async function unwrapWith(
  wrap: Event,
  decrypt: (pubkey: string, ciphertext: string) => Promise<string>,
  opts: UnwrapCoreOptions = {},
): Promise<UnwrapResult> {
  // Failure here is routine: relays hand us every wrap p-tagged to us, and most
  // are not ours to decrypt. A signer that timed out or refused also lands here
  // as `not-for-us` (the SDK has no remote-signer failure taxonomy).
  let sealPlaintext: string;
  try {
    sealPlaintext = await decrypt(wrap.pubkey, wrap.content);
  } catch {
    return { ok: false, reason: "not-for-us" };
  }
  const parsedSeal = parseSeal(sealPlaintext);
  if (!parsedSeal.ok) return parsedSeal;
  const seal = parsedSeal.seal;

  if (typeof seal.kind !== "number" || typeof seal.pubkey !== "string") {
    return { ok: false, reason: "malformed-seal" };
  }

  let rumorPlaintext: string;
  try {
    rumorPlaintext = await decrypt(seal.pubkey, seal.content);
  } catch {
    return { ok: false, reason: "malformed-rumor" };
  }
  const parsedRumor = parseRumor(rumorPlaintext);
  if (!parsedRumor.ok) return parsedRumor;

  return verifySealAndRumor(wrap, seal, parsedRumor.rumor, opts);
}
