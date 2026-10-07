import { finalizeEvent, type Event } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { KIND_NIP98 } from "./constants.js";

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

/**
 * Build the NIP-98 auth event. `body` must be the exact string (e.g. the
 * serialized JSON) that will be sent as the HTTP request body — a mismatch
 * makes servers reject the auth. When `body` is omitted, no `payload` tag is
 * included.
 */
export async function createNip98Event(
  secretKey: Uint8Array,
  url: string,
  method: string,
  body?: string,
): Promise<Event> {
  const tags: string[][] = [
    ["u", url],
    ["method", method.toUpperCase()],
  ];
  if (body !== undefined) {
    tags.push(["payload", await sha256Hex(body)]);
  }
  return finalizeEvent(
    {
      kind: KIND_NIP98,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: "",
    },
    secretKey,
  );
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