/**
 * REQ shaping — pure helpers behind RelayConnection's per-relay queue: when two
 * queued lookups can share one REQ, how to split a REQ a relay would refuse as
 * too large, and how to read a relay's pushback (CLOSED / NOTICE).
 *
 * Merging exists because the app's request pattern is many tiny lookups (one
 * author's relay list, one event by id). A queue alone only spaces those out;
 * merging turns 30 waiting `{kinds:[10002], authors:[x]}` into one REQ.
 *
 * Merging is only done where the merged REQ returns exactly the union of what
 * the parts would have:
 *   - no `limit`: NIP-01 ORs values within a field, so unioning ONE varying
 *     field (everything else identical) is exact;
 *   - `ids`: ids are unique, so the limit is dropped;
 *   - replaceable kinds by author: one event per (author, kind), so the limit
 *     becomes authors × kinds.
 * Anything else with a `limit` ("latest N") never merges — a shared limit would
 * starve some parts.
 */
import type { Filter } from "../core/types";

export function isReplaceableKind(kind: number): boolean {
  return kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

/** Array-valued fields other than `kinds` (the ones a filter can vary along). */
function arrayFields(filter: Filter): string[] {
  return Object.keys(filter).filter(
    (k) => k !== "kinds" && Array.isArray((filter as Record<string, unknown>)[k]),
  );
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface MergeInfo {
  /** Identity of the filter with `field` removed — equal keys may merge. */
  key: string;
  /** The single field that varies between mergeable filters. */
  field: string;
  /** How the merged filter's `limit` is derived. */
  limit: "none" | "drop" | "per-author";
}

/**
 * Whether a REQ (its filter list) can share a REQ with others, and on what.
 * Only single-filter, non-search REQs that vary along exactly one array field.
 */
export function mergeInfo(filters: Filter[]): MergeInfo | null {
  if (filters.length !== 1) return null;
  const f = filters[0] as Filter & Record<string, unknown>;
  if (f.search !== undefined) return null;
  const fields = arrayFields(f);
  let field: string;
  if (fields.includes("ids")) field = "ids";
  else if (fields.length === 1) field = fields[0];
  else return null;

  let limit: MergeInfo["limit"];
  if (field === "ids") limit = f.limit === undefined ? "none" : "drop";
  else if (f.limit === undefined) limit = "none";
  else if (
    field === "authors" &&
    f.kinds?.length &&
    f.kinds.every(isReplaceableKind)
  )
    limit = "per-author";
  else return null;

  const rest: Record<string, unknown> = { ...f };
  delete rest[field];
  if (limit !== "none") delete rest.limit;
  if (rest.kinds) rest.kinds = [...(rest.kinds as number[])].sort((a, b) => a - b);
  return { key: `${field}|${limit}|${stableStringify(rest)}`, field, limit };
}

/** Union mergeable filters (all sharing `info.key`) into one filter. */
export function combineFilters(filters: Filter[], info: MergeInfo): Filter {
  const base = { ...filters[0] } as Filter & Record<string, unknown>;
  const values = new Set<string>();
  for (const f of filters) {
    for (const v of ((f as Record<string, unknown>)[info.field] as string[]) ?? [])
      values.add(v);
  }
  base[info.field] = Array.from(values);
  if (info.limit === "drop") delete base.limit;
  if (info.limit === "per-author")
    base.limit = values.size * (base.kinds?.length ?? 1);
  return base;
}

/** Number of values the merge field would hold after adding `filter`. */
export function mergedSize(filters: Filter[], info: MergeInfo): number {
  const values = new Set<string>();
  for (const f of filters)
    for (const v of ((f as Record<string, unknown>)[info.field] as string[]) ?? [])
      values.add(v);
  return values.size;
}

/** The largest array field of a filter, with its length. */
function largestArray(filter: Filter): { field: string; size: number } | null {
  let best: { field: string; size: number } | null = null;
  for (const k of Object.keys(filter)) {
    const v = (filter as Record<string, unknown>)[k];
    if (k === "kinds" || !Array.isArray(v)) continue;
    if (!best || v.length > best.size) best = { field: k, size: v.length };
  }
  return best;
}

/** Split a filter in two along its largest array, or null if it can't shrink. */
export function halveFilter(filter: Filter): [Filter, Filter] | null {
  const big = largestArray(filter);
  if (!big || big.size < 2) return null;
  const values = (filter as Record<string, unknown>)[big.field] as string[];
  const mid = Math.ceil(values.length / 2);
  return [
    { ...filter, [big.field]: values.slice(0, mid) },
    { ...filter, [big.field]: values.slice(mid) },
  ];
}

/**
 * Split a REQ's filters into REQs a relay will accept: no array field over
 * `maxItems`, and no REQ frame over `maxBytes`. Each returned entry is the filter
 * list for one REQ. A REQ that already fits is returned unchanged (one entry).
 *
 * Splitting a filter that has a `limit` gives each part the full limit, which
 * can only return more events, never fewer.
 */
export function splitFilters(
  filters: Filter[],
  maxItems: number,
  maxBytes: number,
): Filter[][] {
  const fits = (fs: Filter[]) =>
    JSON.stringify(["REQ", "s", ...fs]).length <= maxBytes &&
    fs.every((f) => (largestArray(f)?.size ?? 0) <= maxItems);
  if (fits(filters)) return [filters];

  // Shrink each filter independently, then send each piece as its own REQ.
  const out: Filter[][] = [];
  const work = [...filters];
  while (work.length) {
    const f = work.shift()!;
    if (fits([f])) {
      out.push([f]);
      continue;
    }
    const halves = halveFilter(f);
    if (!halves) out.push([f]); // can't shrink further — let the relay decide
    else work.unshift(...halves);
  }
  return out;
}

export type Pushback =
  /** Slow down: pause this relay (optionally for the relay's stated time). */
  | { type: "rate-limit"; retryMs?: number }
  /**
   * Too many subscriptions (with the relay's stated max, if given). `concurrent`
   * marks the "too many concurrent REQs" family, which limits REQs still loading
   * rather than total open subscriptions.
   */
  | { type: "too-many-subs"; limit?: number; concurrent?: boolean }
  /** The REQ was too large to accept. */
  | { type: "too-large" }
  | { type: "auth-required" }
  | { type: "other" };

/** Parse "retry in 2s" / "retry in 30ms" / "try again in 5 seconds". */
function parseRetryMs(message: string): number | undefined {
  const m = /(?:retry|try again)\s+(?:in|after)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?)\b/i.exec(
    message,
  );
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  if (unit.startsWith("ms") || unit.startsWith("milli")) return n;
  if (unit.startsWith("m") && !unit.startsWith("ms")) return n * 60_000;
  return n * 1000;
}

/**
 * Classify a relay's CLOSED reason or NOTICE text. Relays phrase these freely
 * (NIP-01 only standardises the `rate-limited:` / `auth-required:` prefixes), so
 * this matches the wordings seen in the wild — strfry, nostr-rs-relay, khatru,
 * damus, relay.formstr.app.
 */
export function classifyPushback(message: string): Pushback {
  const m = message.toLowerCase();
  if (m.startsWith("auth-required") || m.includes("auth-required"))
    return { type: "auth-required" };
  if (
    /too many (subscriptions|concurrent|open|reqs?\b)|maximum concurrent|max(imum)? (number of )?subscriptions|subscription (limit|count)/.test(
      m,
    )
  ) {
    // "…must be less than or equal to 10", "max subscriptions: 20", "limit of 32"
    const n = /(?:less than or equal to|at most|max(?:imum)?(?: number of)?(?: subscriptions)?(?: is)?:?|limit(?: of| is)?:?)\s*(\d+)/i.exec(message);
    const limit = n ? parseInt(n[1], 10) : undefined;
    const concurrent = /concurrent/.test(m);
    return {
      type: "too-many-subs",
      ...(limit && limit > 0 ? { limit } : {}),
      ...(concurrent ? { concurrent } : {}),
    };
  }
  if (/too large|too big|too long|items too large|exceeds? (the )?(max|limit)/.test(m))
    return { type: "too-large" };
  if (
    /rate.?limit|too many (messages|requests)|slow down|budget exhausted|throttl/.test(m)
  )
    return { type: "rate-limit", retryMs: parseRetryMs(message) };
  return { type: "other" };
}
