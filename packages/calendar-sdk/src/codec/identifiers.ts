import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { EventRef } from "../types";

/**
 * Shared identifier and timestamp primitives, mirroring nostr-calendar's
 * `src/nostr/core.ts` and `src/utils/calendarListTypes.ts` — docs/protocol.md §3.
 */

/**
 * The `d`-tag idiom used by RSVPs, calendar lists and event ids alike:
 * sha256, hex, truncated to **30** characters. Not 64 — a full-length hash
 * produces a different d-tag and therefore a different addressable event.
 */
export function makeDTag(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input))).substring(0, 30);
}

/**
 * NIP-01 breaks a `created_at` tie between two versions of an addressable event
 * by **lowest event id** — so an edit published in the same second as the
 * version it replaces can silently lose. Stay strictly after the previous one.
 */
export function nextCreatedAt(previousCreatedAtSecs = 0): number {
  return Math.max(Math.floor(Date.now() / 1000), previousCreatedAtSecs + 1);
}

/**
 * Only a second-scale value is a real previous timestamp. Upstream's in-memory
 * model carries `createdAt` in seconds when parsed off a relay but in
 * milliseconds for a locally-built draft (`events.ts:301`); feeding the latter
 * to `nextCreatedAt` would stamp an event ~50,000 years into the future, and
 * relays drop it.
 */
export function previousCreatedAtSeconds(createdAt: number | undefined): number {
  return createdAt && createdAt < 1e12 ? createdAt : 0;
}

/** `<kind>:<authorPubkey>:<dTag>` — the NIP-01 addressable coordinate. */
export function coordinate(kind: number, authorPubkey: string, dTag: string): string {
  return `${kind}:${authorPubkey}:${dTag}`;
}

export function parseCoordinate(
  coord: string,
): { kind: number; authorPubkey: string; dTag: string } | null {
  const parts = coord.split(":");
  if (parts.length < 3) return null;
  const kind = Number(parts[0]);
  if (!Number.isFinite(kind)) return null;
  // A d-tag may itself contain ":" — everything after the second separator is it.
  return { kind, authorPubkey: parts[1], dTag: parts.slice(2).join(":") };
}

/**
 * An event reference as stored in a calendar list:
 * `["<kind>:<author>:<dTag>", "<relayUrl>", "<viewKeyNsec>"]`.
 * `relayUrl` is `""` when unknown — never omitted, because upstream reads the
 * view key positionally from index 2.
 */
export function buildEventRef(params: {
  kind: number;
  authorPubkey: string;
  eventDTag: string;
  relayUrl?: string;
  viewKey: string;
}): EventRef {
  return [
    coordinate(params.kind, params.authorPubkey, params.eventDTag),
    params.relayUrl || "",
    params.viewKey,
  ];
}

export function parseEventRef(ref: readonly string[]): {
  coordinate: string;
  kind: number;
  authorPubkey: string;
  eventDTag: string;
  relayUrl: string;
  viewKey: string;
} | null {
  const parsed = parseCoordinate(ref[0] ?? "");
  if (!parsed) return null;
  return {
    coordinate: ref[0],
    kind: parsed.kind,
    authorPubkey: parsed.authorPubkey,
    eventDTag: parsed.dTag,
    relayUrl: ref[1] ?? "",
    viewKey: ref[2] ?? "",
  };
}
