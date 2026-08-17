import type { Event } from "nostr-tools";

import type { BusyList, BusyRange } from "../types";

/**
 * Public busy list codec (kind 31926) — docs/protocol.md §9. Mirrors
 * `busyListToTags` / `nostrEventToBusyList` in nostr-calendar's
 * `src/utils/parser.ts` and the month helpers in its `dateHelper.ts`.
 *
 * One addressable event per `(user, month)`; the month key IS the d-tag.
 * `content` is intentionally empty — a busy list says *when* you are
 * unavailable and never *why*.
 */

const MONTH_KEY = /^\d{4}-\d{2}$/;

/** `YYYY-MM` for an instant, in **UTC**. */
export function busyListMonthKey(value: number | Date): string {
  const d = typeof value === "number" ? new Date(value) : value;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Every month key a range touches, inclusive. A meeting that runs past
 * midnight on the last day of a month lands in two lists, so both have to be
 * republished when it is added or removed.
 */
export function busyListMonthKeysForRange(startMs: number, endMs: number): string[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return [];
  const [start, end] = startMs <= endMs ? [startMs, endMs] : [endMs, startMs];

  const cursor = new Date(
    Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1),
  );
  const lastMonth = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1);

  const keys: string[] = [];
  while (cursor.getTime() <= lastMonth) {
    keys.push(busyListMonthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return keys;
}

export function isBusyListMonthKey(dTag: string): boolean {
  return MONTH_KEY.test(dTag);
}

/**
 * Tags for one month's list. The caller supplies `kind`, `pubkey`,
 * `created_at` and `content: ""`.
 *
 * `t` rows are queryable hashtags (the month and the literal `busy`), which is
 * how a client finds busy lists without knowing the author up front.
 */
export function busyListToTags(list: Pick<BusyList, "monthKey" | "ranges">): string[][] {
  const tags: string[][] = [
    ["d", list.monthKey],
    ["t", list.monthKey],
    ["t", "busy"],
  ];
  for (const range of list.ranges) {
    tags.push([
      "block",
      String(Math.floor(range.start / 1000)),
      String(Math.floor(range.end / 1000)),
    ]);
  }
  return tags;
}

/** Sorted by `(start, end)` and deduped on exact equality, as upstream does. */
export function normalizeBusyRanges(ranges: readonly BusyRange[]): BusyRange[] {
  const valid = ranges.filter(
    (r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start,
  );
  valid.sort((a, b) => a.start - b.start || a.end - b.end);

  const deduped: BusyRange[] = [];
  for (const range of valid) {
    const last = deduped[deduped.length - 1];
    if (last && last.start === range.start && last.end === range.end) continue;
    deduped.push({ start: range.start, end: range.end });
  }
  return deduped;
}

/**
 * Wire event → `BusyList`. Returns `null` when the d-tag is not a month key —
 * a relay that returns the wrong kind, or a client that reused 31926 for
 * something else, must not corrupt the caller's month index.
 */
export function parseBusyListEvent(event: Event): BusyList | null {
  const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  if (!isBusyListMonthKey(dTag)) return null;

  const ranges: BusyRange[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "block") continue;
    ranges.push({ start: Number(tag[1]) * 1000, end: Number(tag[2]) * 1000 });
  }

  return {
    user: event.pubkey,
    monthKey: dTag,
    ranges: normalizeBusyRanges(ranges),
    eventId: event.id,
    createdAt: event.created_at,
  };
}

export function rangesEqual(a: BusyRange, b: BusyRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Ranges from pre-fetched lists that overlap `[fromMs, toMs)`. Useful for
 * greying out a host's unavailable slots.
 */
export function collectBusyRanges(
  lists: readonly BusyList[],
  fromMs: number,
  toMs: number,
): BusyRange[] {
  const out: BusyRange[] = [];
  for (const list of lists) {
    for (const range of list.ranges) {
      if (range.end <= fromMs || range.start >= toMs) continue;
      out.push(range);
    }
  }
  return out;
}
