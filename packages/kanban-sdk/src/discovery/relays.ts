import type { Event } from "nostr-tools";

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
