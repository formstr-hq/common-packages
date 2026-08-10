import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * Blinded board pointer (doc 05 §2).
 *
 *   b = hex(sha256(utf8("nip100e:v1:" + viewPublicKey + ":" + coordinate)))
 *
 * Published in the single-letter `b` tag of every private card, so a board's
 * cards are fetchable with one relay-side filter — `{"kinds":[32302],"#b":[b]}` —
 * while the relay sees only an opaque 32-byte label. Computable by every view-key
 * holder (viewPublicKey derives from the secret) and by nobody else, because the
 * view pubkey is never published anywhere.
 *
 * `b` authorizes nothing. It is a lookup handle; membership is enforced by
 * decrypting the board and checking its maintainer set (doc 05 §7).
 *
 * The prefix is domain separation: without it this hash could collide with any
 * other protocol hashing the same coordinate under the same key.
 */
export const BLINDED_POINTER_PREFIX = "nip100e:v1";

export function blindedPointer(viewPublicKey: string, coordinate: string): string {
  // Lowercased because the spec fixes hex pubkeys as lowercase and a stray
  // uppercase key would silently produce a second, disjoint pointer — the
  // board's cards would split into two invisible halves.
  const preimage = `${BLINDED_POINTER_PREFIX}:${viewPublicKey.toLowerCase()}:${coordinate}`;
  return bytesToHex(sha256(utf8ToBytes(preimage)));
}
