import { finalizeEvent, type Event, type EventTemplate } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { KIND_NIP98 } from "./constants.js";
import type { MailSigner } from "./signer.js";

/**
 * NIP-98 HTTP auth events (KIND_NIP98=27235), mirroring nail's `nip98.ts`:
 * tags `u` (exact URL), `method` (uppercase), and `payload` (sha256 of the
 * request body, hex) whenever a body is sent.
 *
 * Uses only standard web globals (`crypto.subtle`, `TextEncoder`, `btoa`),
 * so it runs in Node (>=16) and browsers alike without polyfills.
 */

/** sha256 hex of `body`, via WebCrypto. */
function sha256Hex(body: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(body))
    .then((digest) => bytesToHex(new Uint8Array(digest)));
}

/** base64 of the UTF-8 bytes of `s` (btoa works on Latin-1 only, hence the two steps). */
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let binary = "";
  // Chunked so `String.fromCharCode(...)` never overflows argument limits.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Build the unsigned NIP-98 template (kind-27235 with `u`/`method`/`payload`). */
async function buildNip98Template(url: string, method: string, body?: string): Promise<EventTemplate> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (body !== undefined) {
    tags.push(["payload", await sha256Hex(body)]);
  }
  return {
    kind: KIND_NIP98,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: "",
  };
}

/**
 * Build the NIP-98 auth event with a raw secret key. `body` must be the exact
 * string (e.g. the serialized JSON) that will be sent as the HTTP request body
 * — a mismatch makes servers reject the auth. When `body` is omitted, no
 * `payload` tag is included.
 */
export async function createNip98Event(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: string,
): Promise<Event> {
  return finalizeEvent(await buildNip98Template(url, method, body), secretKey);
}

/** Build the NIP-98 auth event through a {@link MailSigner} (NIP-07/NIP-46/MCP). */
export async function createNip98EventWith(
  signer: MailSigner,
  url: string,
  method: string,
  body?: string,
): Promise<Event> {
  return signer.signEvent(await buildNip98Template(url, method, body));
}

/**
 * Build the `Authorization` header value for NIP-98:
 * `Nostr <base64(JSON event)>`.
 */
export async function signNip98(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const event = await createNip98Event(secretKey, url, method, body);
  return `Nostr ${utf8ToBase64(JSON.stringify(event))}`;
}

/** `Authorization` header for NIP-98 through a {@link MailSigner}. */
export async function signNip98With(
  signer: MailSigner,
  url: string,
  method: string,
  body?: string,
): Promise<string> {
  const event = await createNip98EventWith(signer, url, method, body);
  return `Nostr ${utf8ToBase64(JSON.stringify(event))}`;
}
