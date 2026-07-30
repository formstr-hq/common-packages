import type { Event } from "nostr-tools";

import type { NostrRuntime } from "../contracts";
import { KANBAN_KINDS } from "../kinds";

/**
 * NIP-65 relay lists (kind 10002). Publishing to the wrong relays is the single
 * most common cause of "my collaborator can't see the board" — kanbanstr does no
 * NIP-65 handling at all (kanban/docs/03-kanbanstr-review.md §3).
 */

export function normalizeRelayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = parsed.hostname.toLowerCase();
    if (parsed.pathname === "") parsed.pathname = "/";
    return parsed.toString();
  } catch {
    return url;
  }
}

export function normalizeRelayList(urls: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function parseRelayList(event: Event): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];

  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]) continue;
    const marker = tag[2];
    if (marker === "read") read.push(tag[1]);
    else if (marker === "write") write.push(tag[1]);
    else {
      read.push(tag[1]);
      write.push(tag[1]);
    }
  }

  return { read: normalizeRelayList(read), write: normalizeRelayList(write) };
}

/**
 * Each pubkey's NIP-65 READ relays — where they will actually see an event
 * addressed to them. Publishing an invitation only to our own relays is the most
 * common reason a collaborator never receives one (doc 05 §10).
 */
export async function fetchRelayListsForPubkeys(
  runtime: NostrRuntime,
  relays: string[],
  pubkeys: string[],
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (pubkeys.length === 0) return result;

  const events = await runtime.querySync(relays, {
    kinds: [KANBAN_KINDS.relayList],
    authors: pubkeys,
  });

  // Kind 10002 is replaceable: keep the newest per author.
  const newest = new Map<string, Event>();
  for (const event of events) {
    const previous = newest.get(event.pubkey);
    if (!previous || event.created_at > previous.created_at) newest.set(event.pubkey, event);
  }

  for (const [pubkey, event] of newest) {
    const { read } = parseRelayList(event);
    if (read.length > 0) result.set(pubkey, read);
  }
  return result;
}

/**
 * Where to read our own invitation wraps from: the configured relays unioned with
 * our own NIP-65 read relays. An inviter following §10 publishes to the latter,
 * which may not overlap the former at all.
 */
export async function getInvitationInboxRelays(
  runtime: NostrRuntime,
  relays: string[],
  pubkey: string,
): Promise<string[]> {
  try {
    const lists = await fetchRelayListsForPubkeys(runtime, relays, [pubkey]);
    return normalizeRelayList([...relays, ...(lists.get(pubkey) ?? [])]);
  } catch {
    // Relay-list lookup is an optimization; never let it block reading invitations.
    return normalizeRelayList(relays);
  }
}
