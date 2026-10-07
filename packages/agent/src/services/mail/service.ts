import { signerManager, relayManager } from "@formstr/core";
import type { NostrSigner } from "@formstr/core";
import { nip19 } from "nostr-tools";
import {
  readInboxWith,
  sendMailWith,
  publishSetupWith,
  requestMailboxInvoiceWith,
  fetchOwnedAddressesWith,
  defaultFromAddress,
  DEFAULT_MAIL_DOMAIN,
  type MailSigner,
  type MailMessage,
  type MailboxInvoice,
  type SendResult,
  type PublishResult,
} from "@formstr/mailstr-sdk";
import * as profileService from "../profile/service";

/**
 * Mailstr email over the active identity. The service is a thin adapter:
 * `@formstr/mailstr-sdk` owns the protocol (NIP-59 wrap → seal → kind-1301
 * rumor, byte-string content, NIP-98 auth); this layer only supplies the
 * account's signer and the module's relays.
 *
 * The active identity IS the mail identity — mailstr's bridge authorizes a
 * sender by binding the seal pubkey to the NIP-05 record of the From address.
 * One key can own several NIP-05 **aliases** (all sharing this one key and
 * inbox); `sendMail`'s `from` selects which appears in the `From:` header. No
 * private key leaves the signer: mailstr-sdk is handed the `MailSigner`
 * surface, never a secret.
 */

/** Relays to read the inbox from — the mail module's defaults. */
function inboxRelays(): string[] {
  return relayManager.getRelaysForModule("mail");
}

/** The active signer, narrowed to what mailstr-sdk needs. */
async function mailSigner(): Promise<MailSigner> {
  return (await signerManager.getSigner()) as NostrSigner & MailSigner;
}

export interface MailInboxResult {
  mail: MailMessage[];
  /** Wraps that failed to decode, with a reason — never aborts the pass. */
  failures: { wrapId: string; reason: string }[];
}

export interface MailIdentity {
  pubkey: string;
  npub: string;
  /** The `nip05` from the active account's kind-0 profile, if any. */
  nip05: string | null;
}

/** The identity mail is sent as: pubkey, npub, and any bound NIP-05 address. */
export async function mailIdentity(): Promise<MailIdentity> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const profile = await profileService.fetchProfile(pubkey).catch(() => null);
  return { pubkey, npub: nip19.npubEncode(pubkey), nip05: profile?.nip05 ?? null };
}

/**
 * Every NIP-05 alias the active key owns. Empty when the key owns none, the
 * address lookup is unavailable, or the endpoint errors — a listing failure
 * must never block reading or sending mail.
 */
export async function listAliases(): Promise<string[]> {
  const signer = await mailSigner();
  return fetchOwnedAddressesWith(signer).catch(() => []);
}

/**
 * The `From:` address a send will use: an owned registered alias (the bridge
 * only accepts one for external email), else the key's npub mailbox.
 */
export async function defaultSenderAddress(): Promise<string> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  return defaultFromAddress(pubkey, await listAliases());
}

/** Read the inbox: every decodable mail message, plus per-wrap failures. */
export async function readMail(opts: { limit?: number } = {}): Promise<MailInboxResult> {
  const signer = await mailSigner();
  const { mail, failures } = await readInboxWith(signer, {
    relays: inboxRelays(),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  });
  return { mail, failures };
}

export interface SendMailParams {
  /** npub, hex pubkey, or an external email address (routed via the SMTP bridge). */
  to: string;
  subject?: string;
  text?: string;
  /** A fully-formed RFC 2822 message, instead of subject/text. */
  raw?: string;
  /**
   * Which alias to send as (the `From:` header). Omit to use the default: an
   * owned registered alias, else the npub mailbox. A `from` on a domain the
   * bridge serves must be an alias bound to this key or the bridge bounces it.
   */
  from?: string;
}

/** Send mail from the active identity. Returns the wrap and per-relay results. */
export async function sendMail(params: SendMailParams): Promise<SendResult> {
  const signer = await mailSigner();
  const from = params.from ?? (await defaultSenderAddress());
  return sendMailWith(signer, {
    to: params.to,
    ...(params.subject !== undefined ? { subject: params.subject } : {}),
    ...(params.text !== undefined ? { text: params.text } : {}),
    ...(params.raw !== undefined ? { raw: params.raw } : {}),
    from,
    relays: relayManager.getRelaysForModule("mail"),
  });
}

export interface MailSetupParams {
  /** The claimed local part, e.g. "irona" → "irona@mailstr.app". */
  name: string;
  nip05?: string;
  about?: string;
  picture?: string;
}

/** Publish the kind-0 profile (+ nip05) and the kind-10050 DM-relay list. */
export async function publishMailSetup(
  params: MailSetupParams,
): Promise<{ profile: { eventId: string; results: PublishResult[] }; dmRelays: { eventId: string; results: PublishResult[] } }> {
  const signer = await mailSigner();
  const relays = relayManager.getRelaysForModule("mail");
  return publishSetupWith(signer, {
    name: params.name,
    ...(params.nip05 !== undefined ? { nip05: params.nip05 } : {}),
    ...(params.about !== undefined ? { about: params.about } : {}),
    ...(params.picture !== undefined ? { picture: params.picture } : {}),
    relays,
  });
}

/**
 * Request a mailbox invoice, without paying it. A host cannot hold a Lightning
 * wallet, so this stops at the bolt11 invoice; the human pays it out of band
 * (in any wallet), and a later `readMail` starts working once the NIP-05
 * binding propagates.
 */
export async function requestMailbox(
  params: { name: string; tier?: string },
): Promise<MailboxInvoice | { error: string }> {
  const signer = await mailSigner();
  const outcome = await requestMailboxInvoiceWith(signer, {
    name: params.name,
    ...(params.tier !== undefined ? { tier: params.tier } : {}),
    // Never reached: this path requests an invoice and returns without paying.
    payInvoice: () => {
      throw new Error("requestMailbox does not pay");
    },
  });
  if (outcome.status === "ok") return outcome;
  return { error: `Could not create an invoice (${outcome.status}) for ${params.name}@${DEFAULT_MAIL_DOMAIN}.` };
}
