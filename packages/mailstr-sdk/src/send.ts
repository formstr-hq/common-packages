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
  KIND_DM_RELAYS,
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
   * Recipient:
   *   - hex x-only pubkey or `npub1…` → direct Nostr delivery (mailstr
   *     mailboxes are keyed by Nostr public keys; no NIP-05 lookup happens —
   *     the caller resolves addresses to keys if it wants),
   *   - plain email address → rides the domain's SMTP bridge (see
   *     `resolveBridge`); mailstr-local recipients must use their key.
   */
  to: string;
  /** Override the SMTP bridge for email destinations (skips discovery). */
  bridge?: BridgeIdentity;
  /** Domain whose `_smtp` NIP-05 record identifies the bridge. Defaults to
   * the mailstr mail domain. */
  bridgeDomain?: string;
  /** Relays to query for the bridge's kind-10050 list. The bridge's own
   * list wins when found; nail's bootstrap set is the fallback. */
  bridgeRelays?: string[];
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
  /** Envelope key (hex) the chain was encrypted to: the recipient's key for
   * Nostr destinations, the SMTP bridge's key for email destinations. */
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

/** Where a message is headed: a Nostr mailbox key, or a legacy email address. */
export type Destination =
  | { type: "nostr"; pubkey: string }
  | { type: "email"; address: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Resolve any supported destination form. Email destinations route through
 * the domain's SMTP bridge (`resolveBridge`); Nostr destinations behave like
 * `resolveRecipient`. Mailstr-local recipients cannot be named as raw email —
 * local domains are refused by the bridge (`outbound.ts` §6B) and a bare name
 * has no key, so those must be addressed by npub/hex instead. */
export const resolveDestination = (to: string): Destination => {
  if (/^[0-9a-fA-F]{64}$/.test(to) || to.startsWith("npub1")) {
    return { type: "nostr", pubkey: resolveRecipient(to) };
  }
  if (EMAIL_RE.test(to)) {
    const at = to.lastIndexOf("@");
    const local = to.slice(0, at);
    const domain = to.slice(at + 1).toLowerCase();
    if (domain === DEFAULT_MAIL_DOMAIN) {
      throw new Error(
        `recipient on ${domain} must be addressed by npub/hex key — email-form is only for external domains`,
      );
    }
    return { type: "email", address: `${local}@${domain}` };
  }
  throw new Error("destination must be a hex pubkey, npub, or email address");
};

/** The SMTP bridge that carries mailstr mail out to legacy email. Discovered
 * the way the bridge advertises itself (`self-publish.ts`): a `_smtp@<domain>`
 * NIP-05 record for the key, and a kind-10050 relay list telling senders
 * where to publish outbound wraps. */
export interface BridgeIdentity {
  /** Bridge x-only pubkey (hex). Outbound wraps are sealed+wrapped to it. */
  pubkey: string;
  /** Relays the bridge listens on — publish the outbound wrap here. */
  relays: string[];
}

/** Relays worth querying for the bridge's kind-10050 announcement. */
const BRIDGE_QUERY_RELAYS = [
  "wss://relay.formstr.app",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nostr.com",
  "wss://api.formstr.app",
];

/** Fallback when the bridge has no reachable kind-10050: nail's
 * `BOOTSTRAP_RELAYS` default (the bridge's own subscription set). */
const BRIDGE_FALLBACK_RELAYS = [
  "wss://relay.formstr.app",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

const fetchNip05Pubkey = async (name: string, domain: string): Promise<string | null> => {
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`NIP-05 lookup for ${name}@${domain} failed: HTTP ${res.status}`);
  const rec = (await res.json()) as { names?: Record<string, string> };
  return rec.names?.[name] ?? null;
};

/** Resolve the SMTP bridge for a domain: explicit override, else the
 * `_smtp@<domain>` NIP-05 record; relays from the bridge's kind-10050,
 * falling back to nail's bootstrap list. */
export async function resolveBridge(
  opts: { bridge?: BridgeIdentity; domain?: string; bridgeRelays?: string[] } = {},
): Promise<BridgeIdentity> {
  if (opts.bridge) return opts.bridge;
  const domain = opts.domain ?? DEFAULT_MAIL_DOMAIN;
  const pubkey = await fetchNip05Pubkey("_smtp", domain);
  if (!pubkey) {
    throw new Error(
      `no _smtp NIP-05 record for ${domain} — pass a "bridge" for a custom SMTP bridge`,
    );
  }
  let relays = opts.bridgeRelays ?? [];
  if (relays.length === 0) {
    const pool = new SimplePool();
    const evs = await pool
      .querySync(BRIDGE_QUERY_RELAYS, { kinds: [KIND_DM_RELAYS], authors: [pubkey], limit: 1 })
      .catch(() => []);
    relays = [
      ...new Set(
        evs.flatMap((ev) => ev.tags.filter((t) => t[0] === "relay" && t[1]).map((t) => t[1] as string)),
      ),
    ];
    if (!opts.bridgeRelays) pool.close?.(BRIDGE_QUERY_RELAYS);
  }
  if (relays.length === 0) relays = [...BRIDGE_FALLBACK_RELAYS];
  return { pubkey, relays };
}

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
  const dest = resolveDestination(opts.to);
  const senderPubkey = getPublicKey(secretKey);
  const senderNpub = nip19.npubEncode(senderPubkey);

  if (opts.raw === undefined && opts.text === undefined) {
    throw new Error("sendMail needs either `text` or `raw`");
  }

  // Email destinations ride the domain's SMTP bridge: the rumor is sealed and
  // wrapped to the bridge key, which unwraps with the same inbound rules,
  // authorizes the sender (seal pubkey must own the From address's NIP-05
  // record — outbound.ts §5), and relays the `deliver`-tagged targets out
  // over SMTP (local domains are refused — they are reachable over Nostr).
  const bridge =
    dest.type === "email"
      ? await resolveBridge({
          bridge: opts.bridge,
          domain: opts.bridgeDomain,
          bridgeRelays: opts.bridgeRelays,
        })
      : undefined;
  const recipient = dest.type === "email" ? bridge!.pubkey : dest.pubkey;

  const from = opts.from ?? `${senderNpub}@${DEFAULT_MAIL_DOMAIN}`;
  const messageId = opts.raw ? undefined : `<${randomHex(16)}@${DEFAULT_MAIL_DOMAIN}>`;
  const raw =
    opts.raw ??
    buildRawMail(
      from,
      dest.type === "email" ? dest.address : recipient,
      opts.subject ?? "(no subject)",
      opts.text ?? "",
      messageId!,
      now,
    );

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
      // Legacy email targets travel in `deliver` tags — the bridge reads its
      // outbound list from there (`protocol/mail.ts::deliverTargets`), not
      // from the RFC 2822 To: header.
      ...(dest.type === "email" ? [["deliver", dest.address]] : []),
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

  // 4. publish to the recipient's inbox relays — for email destinations, the
  // bridge's listening relays — all-settled like publishSetup.
  const relays = opts.relays ?? (dest.type === "email" ? bridge!.relays : DEFAULT_INBOX_RELAYS);
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