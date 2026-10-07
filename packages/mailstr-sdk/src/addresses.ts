import { nip19 } from "nostr-tools";
import { DEFAULT_CLAIM_API, DEFAULT_MAIL_DOMAIN } from "./claim.js";
import { signNip98, signNip98With } from "./nip98.js";
import type { MailSigner } from "./signer.js";

/**
 * Mailstr alias directory.
 *
 * A mail identity is a single Nostr key; an **alias** is a NIP-05 name
 * (`you@mailstr.app`, or `you@yourdomain.com` on a managed workspace) bound to
 * that key. All aliases share one key and one inbox — mail is encrypted to the
 * key, so which alias it was addressed to is only a header on the message.
 * Sending lets the sender pick which alias appears as the `From:`.
 *
 * This module reads the aliases the signed-in key owns, so a host can offer
 * them (and validate a chosen `from`) instead of guessing.
 */

/** The endpoint that returns the signed-in key's NIP-05 aliases. */
export const OWNED_ADDRESSES_PATH = "/api/nip-05/get-nip05";

/**
 * Normalize the `get-nip05` response into a flat list of full
 * `localpart@domain` addresses. The server shape has varied, so this tolerates
 * each plausible form rather than assuming one; unrecognized input yields no
 * addresses (it never throws). A bare localpart (`abhay`, no `@`) is qualified
 * with the domain on its entry, else the default mail domain.
 */
export function normalizeOwnedAddresses(body: unknown, domain = DEFAULT_MAIL_DOMAIN): string[] {
  const qualify = (addr: string, entryDomain?: unknown): string => {
    if (addr.includes("@")) return addr;
    if (typeof entryDomain === "string" && entryDomain.trim()) return `${addr}@${entryDomain}`;
    return `${addr}@${domain}`;
  };

  if (typeof body === "string") return [qualify(body)];

  let raw: { value: string; domain?: unknown }[] = [];
  if (Array.isArray(body)) {
    raw = body.flatMap((entry): { value: string; domain?: unknown }[] => {
      if (typeof entry === "string") return [{ value: entry }];
      if (entry && typeof entry === "object") {
        const obj = entry as Record<string, unknown>;
        if (typeof obj.nip05 === "string") return [{ value: obj.nip05, domain: obj.domain }];
        if (typeof obj.name === "string") return [{ value: obj.name, domain: obj.domain }];
      }
      return [];
    });
  } else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.nip05 === "string") {
      raw = [{ value: obj.nip05, domain: obj.domain }];
    } else if (Array.isArray(obj.nip05Addresses)) {
      raw = obj.nip05Addresses
        .filter((v): v is string => typeof v === "string")
        .map((value) => ({ value }));
    }
  }
  return raw.map(({ value, domain: d }) => qualify(value, d));
}

export interface FetchJsonResult {
  ok: boolean;
  status: number;
  body: unknown;
}

/** Overridable transport for tests/proxies; defaults to `fetch`. */
export type AddressesFetch = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<FetchJsonResult>;

async function defaultFetch(
  url: string,
  init: { method: string; headers: Record<string, string> },
): Promise<FetchJsonResult> {
  const res = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // empty / non-JSON body → treat as no addresses
  }
  return { ok: res.ok, status: res.status, body };
}

/** Options shared by the two alias-list variants. */
export interface OwnedAddressesOptions {
  /** Mailstr API base (default https://api.formstr.app). */
  api?: string;
  /** NIP-05 domain used to qualify bare localparts (default mailstr.app). */
  domain?: string;
  /** Override HTTP transport (tests, proxies). */
  fetchJson?: AddressesFetch;
}

async function fetchAddresses(
  url: string,
  header: string,
  opts: OwnedAddressesOptions,
): Promise<string[]> {
  const fetchJson = opts.fetchJson ?? defaultFetch;
  const res = await fetchJson(url, { method: "GET", headers: { Authorization: header } });
  // 404 = the backend knows no addresses for this key; 401 = the NIP-98 header
  // was rejected. Neither is an error worth throwing over for a listing.
  if (res.status === 404 || res.status === 401) return [];
  if (!res.ok) throw new Error(`Address lookup failed (${res.status})`);
  return normalizeOwnedAddresses(res.body, opts.domain ?? DEFAULT_MAIL_DOMAIN);
}

/** List the NIP-05 aliases owned by a raw secret key. */
export async function fetchOwnedAddresses(
  secretKey: Uint8Array,
  opts: OwnedAddressesOptions = {},
): Promise<string[]> {
  const api = (opts.api ?? DEFAULT_CLAIM_API).replace(/\/+$/, "");
  // The signed `u` tag must match the URL the server sees; there is no dev
  // proxy here, so sign and fetch the same absolute URL.
  const url = `${api}${OWNED_ADDRESSES_PATH}`;
  return fetchAddresses(url, await signNip98(secretKey, url, "GET"), opts);
}

/** List the NIP-05 aliases owned by a {@link MailSigner}'s key (NIP-07/NIP-46/MCP). */
export async function fetchOwnedAddressesWith(
  signer: MailSigner,
  opts: OwnedAddressesOptions = {},
): Promise<string[]> {
  const api = (opts.api ?? DEFAULT_CLAIM_API).replace(/\/+$/, "");
  const url = `${api}${OWNED_ADDRESSES_PATH}`;
  return fetchAddresses(url, await signNip98With(signer, url, "GET"), opts);
}

/**
 * The default `From:` for a send from `pubkey` — an owned registered alias if
 * the key has one, else the key's npub mailbox. An alias is preferred because
 * the bridge (external email) only accepts a registered alias, while an alias
 * also works for Nostr-native recipients; the npub form works only for the
 * latter, so it is the fallback.
 */
export function defaultFromAddress(pubkey: string, ownedAddresses: string[]): string {
  const isNpubAlias = (a: string) => {
    const at = a.indexOf("@");
    return at > 0 && a.slice(0, at).toLowerCase().startsWith("npub1");
  };
  const alias = ownedAddresses.find((a) => !isNpubAlias(a));
  return alias ?? ownedAddresses[0] ?? `${nip19.npubEncode(pubkey)}@${DEFAULT_MAIL_DOMAIN}`;
}
