import { getPublicKey, SimplePool, type Event, type Filter } from "nostr-tools";
import PostalMime from "postal-mime";
import { messageStringToBytes } from "./bytes.js";
import { KIND_GIFTWRAP } from "./constants.js";
import { unwrapMail, unwrapMailWith } from "./unwrap.js";
import type {
  InboxFailure,
  InboxResult,
  MailMessage,
  ParsedMail,
  UnwrapResult,
} from "./types.js";
import type { MailSigner } from "./signer.js";

/**
 * Relays the reference inbox reader observed. Mailstr delivery reads a
 * sender-published kind-10050 list by default; these are bootstrap fallbacks.
 */
export const DEFAULT_INBOX_RELAYS = [
  "wss://api.formstr.app",
  "wss://relay.formstr.app",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
];

export interface ReadInboxOptions {
  /** Relay pool to query; defaults to {@link DEFAULT_INBOX_RELAYS}. */
  relays?: string[];
  /** Max wraps requested per query (default 100). */
  limit?: number;
  /** Passed through to the unwrap path. */
  maxAgeSeconds?: number;
  /** Passed through to the unwrap path. Defaults to mailstr mail only. */
  acceptKinds?: number[];
  /** Frozen "now" (unix seconds) for deterministic staleness checks. */
  now?: number;
  /**
   * Supply the wraps that match the filter instead of querying relays —
   * tests, cached stores, or custom transports. The SDK's own query is
   * `{ kinds: [1059], "#p": [recipient], limit }` via SimplePool.querySync.
   */
  queryWraps?: (filter: Filter) => Promise<Event[]>;
  /** Override RFC 2822 parsing (defaults to postal-mime). */
  parse?: (content: string, bytes: Uint8Array) => Promise<ParsedMail | null>;
}

/** Shared body of the two `readInbox` variants: query, dedupe, unwrap, parse. */
async function collectInbox(
  recipient: string,
  opts: ReadInboxOptions,
  unwrap: (wrap: Event) => Promise<UnwrapResult> | UnwrapResult,
): Promise<InboxResult> {
  const relays = opts.relays ?? DEFAULT_INBOX_RELAYS;
  const filter: Filter = {
    kinds: [KIND_GIFTWRAP],
    "#p": [recipient],
    limit: opts.limit ?? 100,
  };
  const wraps = opts.queryWraps
    ? await opts.queryWraps(filter)
    : await new SimplePool().querySync(relays, filter);

  // The same wrap is usually visible on several relays; process each id once.
  const seen = new Map<string, Event>();
  for (const wrap of wraps) seen.set(wrap.id, wrap);

  const mail: MailMessage[] = [];
  const failures: InboxFailure[] = [];
  for (const wrap of seen.values()) {
    const unwrapped = await unwrap(wrap);
    if (!unwrapped.ok) {
      failures.push({ wrapId: wrap.id, reason: unwrapped.reason });
      continue;
    }
    const { seal, rumor } = unwrapped;
    // §4: rumor.content is a byte string — one code unit per message octet.
    const bytes = messageStringToBytes(rumor.content);
    const raw = new TextDecoder().decode(bytes);
    // One undecodable message must not abort the pass — parser failures
    // (default postal-mime or an injected parser) fall back to the raw body.
    let parsed: ParsedMail | null = null;
    try {
      parsed =
        (opts.parse ? await opts.parse(raw, bytes) : await parseWithPostalMime(raw, bytes)) ?? null;
    } catch {
      parsed = null;
    }
    mail.push({
      wrapId: wrap.id,
      from: parsed?.from ?? "?",
      to: parsed?.to ?? "?",
      subject: parsed?.subject ?? "(no subject)",
      messageId: parsed?.messageId ?? "",
      text: parsed?.text ?? raw,
      raw,
      seal,
      rumor,
      receivedAt: rumor.created_at,
    });
  }

  return { mail, failures, seenWrapIds: [...seen.keys()] };
}

/**
 * Read the mailstr inbox with a raw secret key: query gift wraps (kind 1059)
 * p-tagged to the identity, unwrap each (wrap → seal → rumor), decode the
 * rumor's byte-string content and parse it as RFC 2822.
 *
 * Only `KIND_MAIL` rumors pass by default; NIP-17 DMs and other NIP-59
 * traffic show up in `failures` with `wrong-rumor-kind` — pass `acceptKinds`
 * to widen. Failed wraps never abort the pass; they are reported per wrap so
 * one hostile sender can't block the rest.
 */
export function readInbox(
  secretKey: Uint8Array,
  opts: ReadInboxOptions = {},
): Promise<InboxResult> {
  return collectInbox(getPublicKey(secretKey), opts, (wrap) =>
    unwrapMail(wrap, secretKey, {
      maxAgeSeconds: opts.maxAgeSeconds,
      acceptKinds: opts.acceptKinds,
      now: opts.now,
    }),
  );
}

/**
 * Read the inbox through a {@link MailSigner} — the NIP-07/NIP-46/MCP path. The
 * pubkey queried is the signer's own; every rule and fallback is otherwise
 * identical to {@link readInbox}.
 */
export async function readInboxWith(
  signer: MailSigner,
  opts: ReadInboxOptions = {},
): Promise<InboxResult> {
  const recipient = await signer.getPublicKey();
  return collectInbox(recipient, opts, (wrap) =>
    unwrapMailWith(wrap, signer, {
      maxAgeSeconds: opts.maxAgeSeconds,
      acceptKinds: opts.acceptKinds,
      now: opts.now,
    }),
  );
}

/**
 * RFC 2822 -> fields via postal-mime. `bytes` (not the decoded `raw`) is what
 * postal-mime wants: the MIME layers need the original octets to honor
 * `Content-Type` charsets like ISO-8859-1. Throws on undecodable input —
 * `readInbox` owns the fallback policy (raw body, placeholder fields).
 */
async function parseWithPostalMime(raw: string, bytes: Uint8Array): Promise<ParsedMail> {
  const parsed = await new PostalMime().parse(bytes);
  if (!parsed) throw new Error("postal-mime returned nothing");
  return {
    from: parsed.from
      ? `${parsed.from.name ?? ""} <${parsed.from.address ?? ""}>`.trim()
      : "?",
    to: (parsed.to ?? []).map((a) => a.address ?? "").filter(Boolean).join(", ") || "?",
    subject: parsed.subject ?? "(no subject)",
    messageId: parsed.messageId ?? "",
    text: parsed.text ?? raw,
  };
}
