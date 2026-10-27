/**
 * NIP-01 filter matching + filter utilities. Pure, platform-free.
 *
 * Ported from `src/nostrRuntime/utils/filterUtils.ts`. `matchFilter` implements
 * NIP-01 semantics: within a field the values are OR'd; across fields (and
 * across distinct #tag keys) they are AND'd. `limit` is NOT applied here — it is
 * a result-set concern handled by the query layer.
 */
import type { Event, Filter } from "nostr-tools";

/**
 * A filter compiled for repeated matching.
 *
 * Cache replay runs `matchFilter` once per candidate event, and the filters
 * involved routinely carry thousands of authors (a follow list / web of trust).
 * The old implementation did `filter.authors.includes(pubkey)` for every event —
 * an O(authors) scan per event, which made cache replay the worker's single
 * biggest CPU cost (see the 0.7.1 feed-stall profile). Sets make the same check
 * O(1). The tag keys are also pre-parsed so we don't walk `Object.entries` for
 * every event.
 */
interface CompiledFilter {
  ids?: Set<string>;
  authors?: Set<string>;
  kinds?: Set<number>;
  search?: string;
  /** Each entry must match (AND); values within an entry are OR'd. */
  tags: Array<{ name: string; values: Set<string> }>;
}

// Filters are immutable in practice: callers build a filter, declare it, and
// later declare a NEW filter (observe `update`, pagination, scope changes). The
// WeakMap keeps compilation tied to the object's lifetime and lets a long-lived
// interest reuse its compiled form across every replayed event.
const compiled = new WeakMap<Filter, CompiledFilter>();

function compile(filter: Filter): CompiledFilter {
  const cached = compiled.get(filter);
  if (cached) return cached;

  const out: CompiledFilter = { tags: [] };
  if (filter.ids) out.ids = new Set(filter.ids);
  if (filter.authors) out.authors = new Set(filter.authors);
  if (filter.kinds) out.kinds = new Set(filter.kinds);
  if (filter.search !== undefined) out.search = filter.search;

  for (const key of Object.keys(filter)) {
    if (!key.startsWith("#")) continue;
    const values = (filter as Record<string, unknown>)[key];
    if (!Array.isArray(values)) continue;
    out.tags.push({ name: key.slice(1), values: new Set(values as string[]) });
  }

  compiled.set(filter, out);
  return out;
}

export function matchFilter(event: Event, filter: Filter): boolean {
  const f = compile(filter);

  if (f.ids && !f.ids.has(event.id)) return false;
  if (f.authors && !f.authors.has(event.pubkey)) return false;
  if (f.kinds && !f.kinds.has(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  if (f.search !== undefined && !matchesSearch(event, f.search)) {
    return false;
  }

  if (f.tags.length === 0) return true;

  // Tag filters: #e, #p, #t, … — each distinct key must be satisfied (AND),
  // any one of its values matching is enough (OR). Build the event's tag-value
  // sets once instead of re-filtering `event.tags` per requested key.
  const present = new Map<string, Set<string>>();
  for (const tag of event.tags) {
    if (!tag || tag.length < 2) continue;
    let values = present.get(tag[0]);
    if (!values) {
      values = new Set();
      present.set(tag[0], values);
    }
    values.add(tag[1]);
  }

  for (const { name, values } of f.tags) {
    const have = present.get(name);
    if (!have) return false;
    let matched = false;
    for (const value of values) {
      if (have.has(value)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }

  return true;
}

/** Approximate NIP-50 matching used to gate cache replay and relay responses. */
export function matchesSearch(event: Event, search: string): boolean {
  const terms = search.toLowerCase().split(/\s+/).filter(Boolean);
  const content = event.content.toLowerCase();
  return terms.every((term) => content.includes(term));
}

/** True if the event matches ANY of the filters (the NIP-01 REQ semantics). */
export function matchAnyFilter(event: Event, filters: Filter[]): boolean {
  return filters.some((f) => matchFilter(event, f));
}

/** Tag index keys for an event, e.g. "e:<id>", "p:<pubkey>", "t:<topic>". */
export function extractTagKeys(event: Event): string[] {
  const keys: string[] = [];
  for (const tag of event.tags || []) {
    if (tag.length >= 2) keys.push(`${tag[0]}:${tag[1]}`);
  }
  return keys;
}

// `reconcile()` asks for the same (filters, relays) key for every standing
// interest on every observe/unobserve tick. Cache the whole hash, not just the
// normalised filters, so a steady state costs no stringify work at all.
const hashCache = new WeakMap<Filter[], { relaysKey: string; hash: string }>();

/** Stable, order-insensitive hash of filters + relays for subscription dedup. */
export function generateFilterHash(filters: Filter[], relays: string[]): string {
  const sortedRelays = [...relays].sort();
  const relaysKey = sortedRelays.join("\u0000");
  const cached = hashCache.get(filters);
  if (cached && cached.relaysKey === relaysKey) return cached.hash;

  const normalized = filters.map(normalizeFilter);
  const hash = simpleHash(JSON.stringify({ filters: normalized, relays: sortedRelays }));
  hashCache.set(filters, { relaysKey, hash });
  return hash;
}

// The same filter object is hashed by `reconcile()` on every observe/unobserve
// tick. Normalising (sorting + copying large author arrays) dominated that path,
// so keep the normalised form for the filter's lifetime.
const normalized = new WeakMap<Filter, Filter>();

export function normalizeFilter(filter: Filter): Filter {
  const cached = normalized.get(filter);
  if (cached) return cached;

  const out: any = {};
  for (const key of Object.keys(filter).sort()) {
    const value = (filter as any)[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value].sort() : value;
  }
  normalized.set(filter, out);
  return out;
}

function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // force 32-bit
  }
  return hash.toString(36);
}

/** Split a filter whose author list exceeds `chunkSize` into smaller filters. */
export function chunkFilter(filter: Filter, chunkSize = 1000): Filter[] {
  if (!filter.authors || filter.authors.length <= chunkSize) return [filter];
  const chunks: Filter[] = [];
  for (let i = 0; i < filter.authors.length; i += chunkSize) {
    chunks.push({ ...filter, authors: filter.authors.slice(i, i + chunkSize) });
  }
  return chunks;
}
