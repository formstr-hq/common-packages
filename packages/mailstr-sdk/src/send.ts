import {
  finalizeEvent,
  getEventHash,
  getPublicKey,
  nip19,
  nip44,
  SimplePool,
  type Event,
} from "nostr-tools";
import { bytesToMessageString } from "./bytes.js";
import {
  KIND_GIFTWRAP,
  KIND_MAIL,
  KIND_SEAL,
  WRAP_KEY_TAG,
} from "./constants.js";
import { DEFAULT_MAIL_DOMAIN } from "./claim.js";
import { DEFAULT_INBOX_RELAYS } from "./inbox.js";
import type { PublishResult } from "./setup.js";

/**
 * Outgoing mail, mirroring nail's send path
 * (`nail/nostr-bridge/src/protocol/mail.ts`) in reverse of the SDK's own
 * `unwrapMail` rules: a kind-1301 mail rumor (RFC 2822 byte-string content)
 * is signed into a kind-13 NIP-59 seal encrypted to the recipient, gift-wrapped
 * with a throwaway ephemeral key into kind 1059, and published to the
 * recipient's inbox relays.
 *
 * Deliberately mirrors the recipient-side guarantees `unwrapMail` checks:
 *   - the rumor's author IS the sender's real key (no third-party spoofing),
 *   - the rumor carries a `WRAP_KEY_TAG` with the ephemeral wrap key so the
 *     recipient can author a NIP-09 kind-5 deletion for the wrap
 *     (`unwrapMail` treats an embedded key that does not derive to the wrap
 *     author as hostile, so senders must embed the truth),
 *   - the rumor carries a `p` tag naming the recipient.
 *
 * Timestamps stay fresh rather than NIP-59-randomized: mailstr's unwrap applies
 * a staleness limit to the *rumor* regardless of the outer anonymity window,
 * and relays accept kind-1059 events with current timestamps fine. Callers who
 * need the full NIP-59 timing pass can rebuild the outer two events themselves
 * and treat this module as the rumor/seal reference.
 */

export interface SendMailOptions {
  /**
   * Recipient as hex x-only pubkey or `npub1…`. Mailstr mailboxes are keyed by
   * Nostr public keys — no NIP-05 lookup happens here (the caller resolves
   * addresses to keys if it wants).
   */
  to: string;
  /** RFC 2822 `Subject`. Required unless `raw` is given. */
  subject?: string;
  /** Plain-text `Content-Type: text/plain` body. Required unless `raw` is given. */
  text?: string;
  /**
   * Send a fully-formed RFC 2822 message instead of building one from
   * `subject`/`text`. `Content-Type` is preserved verbatim — the rumor layer
   * is a byte-string transport and never re-encodes.
   */
  raw?: string;
  /** RFC 2822 `From` header. Defaults to `<npub>@<domain>` for the sender key. */
  from?: string;
  /** Where to publish the wrap. Defaults to mailstr's default inbox relays. */
  relays?: string[];
  /** Overrides the relay-publishing transport (tests, custom pools). */
  pool?: Pick<SimplePool, "publish">;
  /** Fix the clock (unix seconds) for tests; rumor age is measured from this. */
  now?: number;
}

export interface SendResult {
  /** Recipient x-only pubkey (hex) the chain was encrypted to. */
  recipient: string;
  /** The published kind-1059 wrap (dedupe + NIP-09 deletion reference). */
  wrap: Event;
  /** Per-relay publish results, all-settled like `publishSetup`. */
  results: PublishResult[];
}

/** Accept hex x-only pubkeys and bech32 `npub1…`. */
export const resolveRecipient = (to: string): string => {
  if (/^[0-9a-fA-F]{64}$/.test(to)) return to.toLowerCase();
  if (to.startsWith("npub1")) {
    const decoded = nip19.decode(to);
    if (decoded.type !== "npub") throw new Error("unsupported destination: expected npub");
    return String(decoded.data);
  }
  throw new Error("destination must be a hex pubkey or npub");
};

/** Minimal RFC 2822 builder for the common text/plain case. */
const buildRawMail = (
  from: string,
  to: string,
  subject: string,
  text: string,
  messageId: string,
  now: number,
): string => {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${new Date(now * 1000).toUTCString()}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
  ];
  return `${headers.join("\r\n")}\r\n\r\n${text}\r\n`;
};

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

export async function sendMail(
  secretKey: Uint8Array,
  opts: SendMailOptions,
): Promise<SendResult> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const recipient = resolveRecipient(opts.to);
  const senderPubkey = getPublicKey(secretKey);
  const senderNpub = nip19.npubEncode(senderPubkey);

  if (opts.raw === undefined && opts.text === undefined) {
    throw new Error("sendMail needs either `text` or `raw`");
  }

  const from = opts.from ?? `${senderNpub}@${DEFAULT_MAIL_DOMAIN}`;
  const messageId = opts.raw ? undefined : `<${randomHex(16)}@${DEFAULT_MAIL_DOMAIN}>`;
  const raw = opts.raw ?? buildRawMail(from, recipient, opts.subject ?? "(no subject)", opts.text ?? "", messageId!, now);

  // Throwaway wrap key — embedded in the rumor via WRAP_KEY_TAG so the
  // recipient can delete the wrap later (unwrapMail rule 6 verifies this).
  const wrapSecretKey = new Uint8Array(32);
  crypto.getRandomValues(wrapSecretKey);
  const wrapPubkey = getPublicKey(wrapSecretKey);

  // 1. rumor: unsigned by design — never leaves the encryption layers.
  const rumor = {
    id: "",
    kind: KIND_MAIL,
    pubkey: senderPubkey,
    created_at: now,
    tags: [
      ["p", recipient],
      [WRAP_KEY_TAG, Array.from(wrapSecretKey, (b) => b.toString(16).padStart(2, "0")).join("")],
    ],
    content: bytesToMessageString(new TextEncoder().encode(raw)),
  };
  rumor.id = getEventHash(rumor as unknown as Event);

  // 2. seal: signed by the sender, encrypted to the recipient.
  const seal = finalizeEvent(
    {
      kind: KIND_SEAL,
      created_at: now,
      tags: [],
      content: nip44.v2.encrypt(JSON.stringify(rumor), nip44.v2.utils.getConversationKey(secretKey, recipient)),
    },
    secretKey,
  );

  // 3. gift wrap: signed by the ephemeral key, encrypted to the recipient.
  const wrap = finalizeEvent(
    {
      kind: KIND_GIFTWRAP,
      created_at: now,
      tags: [["p", recipient]],
      content: nip44.v2.encrypt(JSON.stringify(seal), nip44.v2.utils.getConversationKey(wrapSecretKey, recipient)),
    },
    wrapSecretKey,
  );

  // 4. publish to the recipient's inbox relays, all-settled like publishSetup.
  const relays = opts.relays ?? DEFAULT_INBOX_RELAYS;
  const pool = opts.pool ?? new SimplePool();
  const settled = await Promise.allSettled(pool.publish(relays, wrap));
  const results: PublishResult[] = settled.map((r, i) => ({
    relay: relays[i] ?? "",
    ok: r.status === "fulfilled",
    detail: r.status === "fulfilled" ? String(r.value ?? "OK") : String(r.reason).slice(0, 300),
  }));
  if (!opts.pool) (pool as SimplePool).close?.(relays);

  return { recipient, wrap, results };
}