import { nip19 } from "nostr-tools";
import { identityFromSecretKey } from "./identity.js";
import { signNip98, signNip98With } from "./nip98.js";
import type { MailSigner } from "./signer.js";

/**
 * Mailstr mailbox claim/purchase flow (port of the reference claim script):
 *
 *   1. check the NIP-05 name is still free,
 *   2. POST a NIP-98-signed invoice request to the mailstr API,
 *   3. hand the bolt11 invoice to a caller-supplied payer (Lightning wallet
 *      hook — the SDK never touches mnemonics or funds itself),
 *   4. watch the API's payment WebSocket for `{ status: "paid" }`,
 *   5. poll the NIP-05 `.well-known/nostr.json` until the name binds to our
 *      pubkey (or the deadline passes).
 *
 * The payment hook keeps wallets out of the SDK: pass `payInvoice` backed by
 * NWC, Spark, a LNURL-withdraw service, or a human prompt.
 */

export const DEFAULT_CLAIM_API = "https://api.formstr.app";
export const DEFAULT_MAIL_DOMAIN = "mailstr.app";
export const DEFAULT_TIER = "base";

/** Minimal shape the SDK needs from a WebSocket for payment watching. */
export interface PaymentWatcher {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export type WebSocketFactory = (url: string) => PaymentWatcher;

/** JSON-over-HTTP result abstraction so `claimMailbox` is testable. */
export type FetchJson = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; body: unknown }>;

/**
 * Pay one bolt11 invoice. Return `{ preimage }` if the wallet exposes one;
 * anything else (void) is fine — preimage is only reported back.
 */
export type InvoicePayer = (
  invoice: string,
  amountSats: number | undefined,
) => Promise<{ preimage?: string | null } | void>;

export interface ClaimMailboxOptions {
  /** NIP-05 local part to claim, e.g. "irona" → "irona@mailstr.app". */
  name: string;
  /** Claim tier (default "base"). */
  tier?: string;
  /** Mailstr API base (default https://api.formstr.app). */
  api?: string;
  /** NIP-05 domain (default mailstr.app). */
  domain?: string;
  /** Pays the bolt11 invoice — required. */
  payInvoice: InvoicePayer;
  /** Override HTTP+JSON (tests, proxies). Default: fetch + 20s timeout. */
  fetchJson?: FetchJson;
  /**
   * WebSocket factory for payment watching. Omit for `globalThis.WebSocket`
   * (Node >=22, browsers); pass `null` to disable watching and poll only;
   * pass a custom factory in tests.
   */
  WebSocket?: WebSocketFactory | null;
  /** Overall claim deadline in ms (default 300000). */
  timeoutMs?: number;
  /** How long to keep the payment WebSocket open in ms (default 240000). */
  wsTimeoutMs?: number;
  /** NIP-05 polling interval in ms (default 10000). */
  pollIntervalMs?: number;
  /** Sleep between polls; injectable for tests. */
  delay?: (ms: number) => Promise<void>;
}

export interface ClaimBound {
  nip05: string;
  pubkey: string;
  npub: string;
  paymentHash: string;
  amountSats: number | undefined;
}

export type ClaimOutcome =
  | { status: "name-taken" }
  | { status: "invoice-request-failed"; httpStatus: number; detail: string }
  | { status: "invoice-shape-unexpected"; detail: string }
  | { status: "payment-failed"; error: string }
  | ({ status: "claimed"; preimage: string | null } & ClaimBound)
  | ({
      status: "paid-binding-pending" | "payment-sent-binding-unverified";
    } & ClaimBound);

const FALLBACK_FETCH_MS = 20_000;

/** A minted mailbox invoice, before payment. */
export interface MailboxInvoice {
  /** bolt11 invoice to pay. */
  invoice: string;
  /** Payment hash — needed to watch/subscribe to payment status. */
  paymentHash: string;
  /** Amount in sats, when the API states one. */
  amountSats: number | undefined;
  /** The NIP-05 address this invoice buys, e.g. "irona@mailstr.app". */
  nip05: string;
}

/**
 * Result of requesting a mailbox invoice. `ok` carries the invoice; otherwise
 * a status matching {@link ClaimOutcome}'s pre-payment failures, so callers can
 * surface the same reasons — and, crucially, a host that holds no wallet can
 * stop here and let the human pay out of band.
 */
export type MailboxInvoiceOutcome =
  | ({ status: "ok" } & MailboxInvoice)
  | { status: "name-taken" }
  | { status: "invoice-request-failed"; httpStatus: number; detail: string }
  | { status: "invoice-shape-unexpected"; detail: string };

/** Everything the claim flow needs from an identity — key or signer backed. */
interface ClaimIdentity {
  pubkey: string;
  npub: string;
  /** NIP-98 `Authorization` header for a given request. */
  auth: (url: string, method: string, body: string) => Promise<string>;
}

/**
 * Request a mailbox invoice without paying it — the half of {@link claimMailbox}
 * for a host that cannot hold a Lightning wallet. Signs the NIP-98 request with
 * `identity.auth`, returns the bolt11 invoice and its payment hash, and leaves
 * payment (and the NIP-05 binding poll) to the caller.
 */
async function requestInvoice(
  identity: ClaimIdentity,
  opts: ClaimMailboxOptions,
): Promise<MailboxInvoiceOutcome> {
  const api = (opts.api ?? DEFAULT_CLAIM_API).replace(/\/+$/, "");
  const domain = opts.domain ?? DEFAULT_MAIL_DOMAIN;
  const tier = opts.tier ?? DEFAULT_TIER;
  const nip05 = `${opts.name}@${domain}`;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const namesUrl = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(opts.name)}`;

  // The name must still be free. A failed availability probe is not blocking:
  // the invoice API validates ownership server-side anyway, and relays serving
  // NIP-05 are often flakier than the API itself.
  let avail: Awaited<ReturnType<FetchJson>> | undefined;
  try {
    avail = await fetchJson(namesUrl);
  } catch {
    avail = undefined;
  }
  const availBody = avail?.body as { names?: Record<string, string> } | undefined;
  if (avail?.ok && availBody?.names && Object.keys(availBody.names).includes(opts.name)) {
    return { status: "name-taken" };
  }

  const body = JSON.stringify({ pubkey: identity.pubkey, nip05, tierId: tier });
  const invoiceUrl = `${api}/api/generate-invoice/mail`;
  const auth = await identity.auth(invoiceUrl, "POST", body);
  let inv: Awaited<ReturnType<FetchJson>>;
  try {
    inv = await fetchJson(invoiceUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: auth },
      body,
    });
  } catch (e) {
    return { status: "invoice-request-failed", httpStatus: 0, detail: String(e) };
  }
  if (!inv.ok) {
    return { status: "invoice-request-failed", httpStatus: inv.status, detail: summarize(inv.body) };
  }
  const invoiceBody = (inv.body ?? {}) as { invoice?: string; paymentHash?: string; amount?: number };
  if (!invoiceBody.invoice || !invoiceBody.paymentHash) {
    return { status: "invoice-shape-unexpected", detail: summarize(inv.body) };
  }
  return {
    status: "ok",
    invoice: invoiceBody.invoice,
    paymentHash: invoiceBody.paymentHash,
    amountSats: invoiceBody.amount,
    nip05,
  };
}

/** Shared body of the two claim variants. */
async function claim(identity: ClaimIdentity, opts: ClaimMailboxOptions): Promise<ClaimOutcome> {
  const delay = opts.delay ?? defaultDelay;
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const wsTimeoutMs = opts.wsTimeoutMs ?? 240_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 10_000;
  const domain = opts.domain ?? DEFAULT_MAIL_DOMAIN;
  const nip05 = `${opts.name}@${domain}`;
  const fetchJson = opts.fetchJson ?? defaultFetchJson;
  const api = (opts.api ?? DEFAULT_CLAIM_API).replace(/\/+$/, "");
  const namesUrl = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(opts.name)}`;

  // 0-1) Availability probe + NIP-98-signed invoice request.
  const req = await requestInvoice(identity, opts);
  if (req.status !== "ok") {
    if (req.status === "name-taken") return { status: "name-taken" };
    return req;
  }
  const { invoice, paymentHash, amountSats: amount } = req;

  // 2) Pay through the caller's hook — the SDK holds no wallets or secrets.
  let preimage: string | null;
  try {
    const paid = await opts.payInvoice(invoice, amount);
    preimage = paid?.preimage ?? null;
  } catch (e) {
    return { status: "payment-failed", error: String(e) };
  }

  // 3) Watch the payment WebSocket; a `{ status: "paid" }` message confirms
  // payment ahead of NIP-05 propagation. Unavailable/broken sockets degrade
  // to polling only; unparseable messages are ignored.
  let paidViaWs = false;
  if (opts.WebSocket !== null) {
    try {
      const ws = (opts.WebSocket ?? defaultWebSocketFactory)(
        `${api.replace(/^http/, "ws")}/ws?hash=${encodeURIComponent(paymentHash)}`,
      );
      const closeTimer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      }, wsTimeoutMs);
      (closeTimer as unknown as { unref?: () => void }).unref?.();
      ws.onmessage = (ev) => {
        let status: unknown;
        try {
          status = (JSON.parse(String(ev.data)) as { status?: unknown }).status;
        } catch {
          return; // keepalive noise / non-JSON frame
        }
        if (status === "paid") {
          paidViaWs = true;
          try {
            ws.close();
          } catch {
            // already closed
          }
        }
      };
      ws.onerror = () => {}; // polling is the safety net
    } catch {
      // WebSocket unavailable in this runtime — polling only.
    }
  }

  // 4) Poll NIP-05 binding until the deadline. Once payment is confirmed via
  // WS and *some* binding exists, stop early rather than poll the full
  // deadline (the API and the NIP-05 endpoint can disagree on propagation).
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollIntervalMs);
    let chk: Awaited<ReturnType<FetchJson>>;
    try {
      chk = await fetchJson(namesUrl);
    } catch {
      continue;
    }
    const names = (chk.body as { names?: Record<string, string> } | undefined)?.names;
    const owner = names?.[opts.name];
    if (owner === identity.pubkey) {
      return {
        status: "claimed",
        preimage,
        nip05,
        pubkey: identity.pubkey,
        npub: identity.npub,
        paymentHash,
        amountSats: amount,
      };
    }
    if (paidViaWs && owner) {
      return {
        status: "paid-binding-pending",
        nip05,
        pubkey: identity.pubkey,
        npub: identity.npub,
        paymentHash,
        amountSats: amount,
      };
    }
  }

  return {
    status: paidViaWs ? "paid-binding-pending" : "payment-sent-binding-unverified",
    nip05,
    pubkey: identity.pubkey,
    npub: identity.npub,
    paymentHash,
    amountSats: amount,
  };
}

/** Claim a mailbox with a raw secret key (dedicated-mail-identity path). */
export async function claimMailbox(
  secretKey: Uint8Array,
  opts: ClaimMailboxOptions,
): Promise<ClaimOutcome> {
  const identity = identityFromSecretKey(secretKey);
  return claim(
    {
      pubkey: identity.pubkey,
      npub: identity.npub,
      auth: (url, method, body) => signNip98(secretKey, url, method, body),
    },
    opts,
  );
}

/** Request a mailbox invoice with a raw secret key, without paying it. */
export async function requestMailboxInvoice(
  secretKey: Uint8Array,
  opts: ClaimMailboxOptions,
): Promise<MailboxInvoiceOutcome> {
  const identity = identityFromSecretKey(secretKey);
  return requestInvoice(
    {
      pubkey: identity.pubkey,
      npub: identity.npub,
      auth: (url, method, body) => signNip98(secretKey, url, method, body),
    },
    opts,
  );
}

/**
 * Claim a mailbox through a {@link MailSigner} (NIP-07/NIP-46/MCP). The NIP-98
 * invoice request is signed by the host signer, so its pubkey is the one the
 * claimed address will bind to.
 */
export async function claimMailboxWith(
  signer: MailSigner,
  opts: ClaimMailboxOptions,
): Promise<ClaimOutcome> {
  const pubkey = await signer.getPublicKey();
  return claim(
    {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      auth: (url, method, body) => signNip98With(signer, url, method, body),
    },
    opts,
  );
}

/**
 * Request a mailbox invoice through a {@link MailSigner}, without paying it.
 * This is the entry point for hosts that hold no wallet (the MCP): it returns a
 * bolt11 invoice for the human to pay, and the caller polls NIP-05 for binding.
 */
export async function requestMailboxInvoiceWith(
  signer: MailSigner,
  opts: ClaimMailboxOptions,
): Promise<MailboxInvoiceOutcome> {
  const pubkey = await signer.getPublicKey();
  return requestInvoice(
    {
      pubkey,
      npub: nip19.npubEncode(pubkey),
      auth: (url, method, body) => signNip98With(signer, url, method, body),
    },
    opts,
  );
}

function summarize(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return (s ?? "").slice(0, 300);
}

/** Node-friendly sleep: unrefs the timer so a pending delay never holds the process open. */
export function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    (setTimeout(resolve, ms) as unknown as { unref?: () => void }).unref?.();
  });
}

const defaultFetchJson: FetchJson = async (url, init) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FALLBACK_FETCH_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  } finally {
    clearTimeout(timer as unknown as number);
  }
};

const defaultWebSocketFactory: WebSocketFactory = (url) =>
  // Node >=22 and browsers expose WebSocket globally; `new undefined()` below
  // throws and is caught by claimMailbox → polling fallback (old Node).
  new (globalThis as unknown as { WebSocket: new (url: string) => PaymentWatcher }).WebSocket(url);
