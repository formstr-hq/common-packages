import type { Event } from "nostr-tools";

/**
 * An unsigned inner event (no `sig`). `id` is computed over the six fields,
 * mirroring nail's `Rumor` type so unwrap verification holds against events
 * built with nostr-tools' own hashing.
 */
export interface Rumor {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * Why a gift wrap failed to unwrap.
 *
 * `not-for-us` is routine — relays hand every wrap p-tagged to us even when it
 * was encrypted to a different key. Every other value means the input is
 * malformed, stale, or hostile and should be surfaced to the caller/counted,
 * not silently dropped.
 *
 * Nail's type also has `signer-error` (transient NIP-46 signer failure); the
 * SDK unwraps with a local secret key, so a decrypt throw can only mean
 * "not encrypted to us" and there is no distinct signer-failure state.
 */
export type UnwrapFailure =
  | "not-for-us"
  | "malformed-seal"
  | "bad-seal-signature"
  | "wrong-seal-kind"
  | "malformed-rumor"
  | "author-mismatch"
  | "wrong-rumor-kind"
  | "wrapkey-mismatch"
  | "expired";

export type UnwrapResult =
  | {
      ok: true;
      /** The verified seal event. */
      seal: Event;
      /** The verified rumor — the actual mail/DM event. */
      rumor: Rumor;
      /**
       * Hex of the wrap author's ephemeral signing key when the sender embedded
       * it via `WRAP_KEY_TAG`; lets the recipient author a NIP-09 kind-5
       * deletion request relays honor for this wrap.
       */
      wrapSecret?: string;
    }
  | { ok: false; reason: UnwrapFailure };

/** A freshly derived (or restored) mailstr identity. Storage is the caller's job. */
export interface MailstrIdentity {
  /** Raw 32-byte secret key — treat as a secret. */
  secretKey: Uint8Array;
  /** `secretKey` as lowercase hex. */
  secretKeyHex: string;
  /** Hex x-only public key. */
  pubkey: string;
  /** bech32 `npub1…` encoding of `pubkey`. */
  npub: string;
}

/** RFC 2822 fields extracted from a decoded mail rumor via postal-mime. */
export interface ParsedMail {
  /** `Name <address>` of the first From header, or `"?"`. */
  from: string;
  /** Comma-joined To addresses, or `"?"`. */
  to: string;
  subject: string;
  messageId: string;
  /** Plain-text body, or the raw decoded content when parsing failed. */
  text: string;
}

/** One decodable mail recovered from the inbox. */
export interface MailMessage extends ParsedMail {
  /** id of the outer gift wrap, for dedupe/NIP-09 deletion. */
  wrapId: string;
  /** The RFC 2822 content decoded from the rumor's byte-string. */
  raw: string;
  seal: Event;
  rumor: Rumor;
  /** `rumor.created_at` as unix seconds. */
  receivedAt: number;
}

/** A gift wrap that failed to unwrap while reading the inbox. */
export interface InboxFailure {
  wrapId: string;
  reason: UnwrapFailure;
}

/** Result of one `readInbox` pass. */
export interface InboxResult {
  mail: MailMessage[];
  failures: InboxFailure[];
  /** All distinct wrap ids seen on the relays, decoded or not. */
  seenWrapIds: string[];
}