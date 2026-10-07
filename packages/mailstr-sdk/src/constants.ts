/**
 * Wire constants shared with mailstr's server stack
 * (`nail/nostr-bridge/src/protocol/constants.ts` — keep in sync).
 */

/** Final mail event — an RFC 2822 message carried in `rumor.content`. */
export const KIND_MAIL = 1301;

/** NIP-59 seal: signed rumor, encrypted to the recipient. */
export const KIND_SEAL = 13;

/** NIP-59 gift wrap: signed seal, encrypted to an ephemeral wrap key. */
export const KIND_GIFTWRAP = 1059;

/** Kind 0 profile event; `publishSetup` sets `nip05` on it. */
export const KIND_PROFILE = 0;

/** NIP-17 DM relay list; mailstr delivery targets read this event. */
export const KIND_DM_RELAYS = 10050;

/** NIP-98 HTTP auth event (`Authorization: Nostr <base64(event)>`). */
export const KIND_NIP98 = 27235;

/**
 * Rumor tag carrying the gift wrap's ephemeral signing key (hex), so the
 * recipient can author a NIP-09 kind-5 deletion relays will honor. Mirrors
 * `WRAP_KEY_TAG` in `nail/nostr-bridge/src/protocol/mail.ts`.
 */
export const WRAP_KEY_TAG = "wrapkey";

/**
 * Default staleness limit applied to unwrapped rumors, matching
 * `MAX_RUMOR_AGE_SECONDS` in nail's protocol constants (overridable via
 * `unwrapMail`/`readInbox` options). NIP-59 itself randomizes outer wrap/seal
 * timestamps into a 2-day window — that window is not the rumor age limit.
 */
export const MAX_RUMOR_AGE_SECONDS = 300;