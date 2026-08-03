import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import type { NostrRuntime } from "../contracts";

/**
 * Relay discovery and routing — docs/protocol.md §11.
 *
 * The default set is nostr-calendar's `defaultRelays` (`src/common/relayConfig.ts`).
 * Sharing it matters: a relay hint embedded in an invitation is only useful if
 * both clients actually reach that relay.
 */
export const DEFAULT_CALENDAR_RELAYS: readonly string[] = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://relay.nostr.wirednet.jp",
  "wss://nostr-01.yakihonne.com",
  "wss://relay.snort.social",
  "wss://nostr21.com",
];

/**
 * Lowercases the host and strips the trailing slash so `wss://nos.lol/` and
 * `wss://nos.lol` are one relay rather than two sockets and two copies of every
 * subscription.
 */
export function normalizeRelayUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    parsed.hostname = parsed.hostname.toLowerCase();
    const normalized = parsed.toString();
    return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** Normalized, de-duplicated, order-preserving. */
export function normalizeRelayList(urls: readonly (string | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url) continue;
    const normalized = normalizeRelayUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/** `r` rows of a NIP-65 relay list. */
export function parseRelayListEvent(event: Event): string[] {
  return normalizeRelayList(event.tags.filter((t) => t[0] === "r" && t[1]).map((t) => t[1]));
}

/**
 * NIP-65 relay lists for many pubkeys in one query. Pubkeys with no list are
 * absent from the map.
 *
 * Call this BEFORE publishing anything `p`-tagged. Without it a gift wrap only
 * reaches the sender's own relays, and a recipient who reads elsewhere never
 * learns they were invited.
 */
export async function fetchRelayLists(
  runtime: NostrRuntime,
  relays: string[],
  pubkeys: string[],
  timeoutMs?: number,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (pubkeys.length === 0) return result;

  const events = await runtime.querySync(
    relays,
    { kinds: [CALENDAR_KINDS.relayList], authors: pubkeys },
    timeoutMs,
  );

  // Keep the newest list per author: relays hand back older versions during
  // backfill, and an outdated list routes to relays the user has abandoned.
  const newest = new Map<string, Event>();
  for (const event of events) {
    const existing = newest.get(event.pubkey);
    if (!existing || event.created_at > existing.created_at) newest.set(event.pubkey, event);
  }
  for (const [pubkey, event] of newest) {
    const list = parseRelayListEvent(event);
    if (list.length > 0) result.set(pubkey, list);
  }
  return result;
}

/**
 * Where to publish an event that `p`-tags people: the configured relays plus
 * every recipient's own. Mirrors the union upstream's worker performs
 * internally (`user relays ∪ author outbox ∪ recipient inbox`) — a plain pool
 * has to do it explicitly.
 */
export function outboxRelaysFor(
  configuredRelays: readonly string[],
  recipientRelays: Map<string, string[]>,
  recipients: readonly string[],
): string[] {
  const urls: string[] = [...configuredRelays];
  for (const recipient of recipients) {
    for (const url of recipientRelays.get(recipient) ?? []) urls.push(url);
  }
  return normalizeRelayList(urls);
}

/** Publishes the caller's own NIP-65 list. */
export function buildRelayListTags(relays: readonly string[]): string[][] {
  return normalizeRelayList(relays).map((url) => ["r", url]);
}
