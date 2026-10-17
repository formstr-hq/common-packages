import type { Event } from "nostr-tools";

import { PAGES_KINDS } from "./types";
import { decryptWithViewKey, pubkeyFromHex } from "./viewKey";

/**
 * Multi-writer encrypted documents — the v2 Pages sharing protocol
 * (`nostr-docs/NIP-multi-writer-documents.md`).
 *
 * A document is a set of per-author replaceable content events (kind 33457),
 * all encrypted with one shared `viewKey`; the newest across the authorized
 * authors is the document. The owner publishes a viewKey-encrypted roster
 * (kind 34579) naming the editors. This module is the pure, React-free model:
 * address helpers, roster parse/encode, author sets, and deterministic tip
 * selection. All I/O lives in `service.ts`; realtime lives in `realtime.ts`.
 *
 * It deliberately mirrors `nostr-docs/src/nostr/sharedDoc.ts` so the two
 * clients stay wire-compatible. Where they differ the NIP is canonical.
 */

/** How far in the future an event's `created_at` may be before the excess is
 *  ignored when ordering (relays do not validate timestamps). */
export const MAX_CLOCK_SKEW_SEC = 5 * 60;

export type DocRole = "editor" | "viewer";

/**
 * How write access is granted:
 * - `restricted` — only listed `editor` members (and the owner) may author.
 * - `open` — capability model: any holder of the viewKey may author.
 * Control metadata (roster/mode/title/tags) is always owner-authored either way.
 */
export type DocMode = "restricted" | "open";

export interface DocMember {
  pubkey: string;
  role: DocRole;
}

/**
 * Owner-authored, viewKey-encrypted document metadata and access list. Stored in
 * a kind-34579 event whose `d` tag is the document's root address. This is the
 * same shape nostr-docs calls `DocRoster`; `title`/`tags` from the legacy
 * self-encrypted metadata live here too for group docs.
 */
export interface DocRoster {
  v: 2;
  mode: DocMode;
  title?: string;
  tags: string[];
  members: DocMember[];
}

/** Parsed components of a root address `33457:<owner>:<d>`. */
export interface RootRef {
  kind: number;
  owner: string;
  d: string;
}

// ── Address helpers ─────────────────────────────────────

/**
 * Parse a `kind:pubkey:d` address into its parts. The `d` may itself contain `:`
 * (metadata `d` tags embed a full address), so everything after the second colon
 * is the identifier.
 */
export function parseRootAddress(address: string): RootRef | null {
  const parts = address.split(":");
  if (parts.length < 3) return null;
  const kind = Number(parts[0]);
  if (!Number.isFinite(kind)) return null;
  return { kind, owner: parts[1], d: parts.slice(2).join(":") };
}

/** Canonical root address for a document owned by `owner` with id `d`. */
export function rootAddress(owner: string, d: string): string {
  return `${PAGES_KINDS.document}:${owner}:${d}`;
}

/** `d` tag value for the owner's roster event: the document's root address. */
export function rosterDTag(owner: string, d: string): string {
  return rootAddress(owner, d);
}

/**
 * Capability-derived, opaque identifier for a document's collaboration channel:
 * `getPublicKey(viewKey)`. Only viewKey holders can compute it, and it reveals
 * nothing about the viewKey (ECDLP) — keeping the root address and owner out of
 * the tags of presence, CRDT ops and session attestations.
 */
export function collabRoom(viewKey: string): string {
  return pubkeyFromHex(viewKey);
}

/**
 * Tags for a v2 content event: `["d", d]` always, plus `["a", room]` for a
 * shared (viewKey) doc so any version is discoverable without enumerating
 * authors. Personal docs carry only the `d` tag (byte-identical to v1).
 */
export function contentTags(d: string, viewKey?: string): string[][] {
  return viewKey ? [["d", d], ["a", collabRoom(viewKey)]] : [["d", d]];
}

// ── Roster ──────────────────────────────────────────────

/** Parse and validate a decrypted roster payload. Returns null when malformed. */
export function parseRosterPayload(payload: string): DocRoster | null {
  try {
    const parsed = JSON.parse(payload) as Partial<DocRoster>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const members = Array.isArray(parsed.members) ? parsed.members : [];
    const validMembers: DocMember[] = members
      .filter(
        (m): m is DocMember =>
          !!m &&
          typeof m.pubkey === "string" &&
          (m.role === "editor" || m.role === "viewer"),
      )
      .map((m) => ({ pubkey: m.pubkey, role: m.role }));
    return {
      v: 2,
      mode: parsed.mode === "open" ? "open" : "restricted",
      title: typeof parsed.title === "string" ? parsed.title : undefined,
      tags: Array.isArray(parsed.tags)
        ? parsed.tags.filter((t): t is string => typeof t === "string")
        : [],
      members: validMembers,
    };
  } catch {
    return null;
  }
}

/** Decrypt a roster event's content with the viewKey and parse it. */
export async function decodeRosterEvent(event: Event, viewKey: string): Promise<DocRoster | null> {
  try {
    return parseRosterPayload(await decryptWithViewKey(viewKey, event.content));
  } catch {
    return null;
  }
}

/**
 * Pubkeys authorized to author content in `restricted` mode: the owner plus
 * every member with the `editor` role. Meaningless in `open` mode.
 */
export function authorSet(owner: string, roster: DocRoster | null): string[] {
  const set = new Set<string>([owner]);
  if (roster) {
    for (const m of roster.members) {
      if (m.role === "editor") set.add(m.pubkey);
    }
  }
  return [...set];
}

/** True when write access is by capability (viewKey) rather than a roster. */
export function isOpenRoster(roster: DocRoster | null): boolean {
  return roster?.mode === "open";
}

// ── Resolution ──────────────────────────────────────────

/**
 * Deterministic tip selection across authors. Newest by `created_at`, ties
 * broken by ascending event id so every client agrees. Future timestamps are
 * clamped to `now + MAX_CLOCK_SKEW_SEC`.
 */
export function selectTip(events: Event[], now = Date.now()): Event | null {
  if (events.length === 0) return null;
  const maxCreatedAt = Math.floor(now / 1000) + MAX_CLOCK_SKEW_SEC;
  const createdAt = (e: Event) => Math.min(e.created_at, maxCreatedAt);
  return [...events].sort((a, b) => {
    const at = createdAt(a);
    const bt = createdAt(b);
    if (at !== bt) return bt - at; // newest first
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable tie-break
  })[0];
}
