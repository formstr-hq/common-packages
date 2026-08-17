import { CALENDAR_KINDS } from "../kinds";
import type { CalendarCtx } from "../contracts";
import type { BusyList, BusyRange } from "../types";
import {
  busyListMonthKeysForRange,
  busyListToTags,
  normalizeBusyRanges,
  parseBusyListEvent,
  rangesEqual,
} from "../codec/busyList";
import { nextCreatedAt, previousCreatedAtSeconds } from "../codec/identifiers";
import { newestByDTag } from "../discovery/dedupe";
import { signAndPublish } from "./publish";

/**
 * Public busy lists — docs/protocol.md §9.
 *
 * One addressable event per `(user, YYYY-MM)`. A range spanning a month
 * boundary is stored WHOLE in every month it touches, so removal can match it
 * by exact pair no matter which month's list is examined.
 */

export async function publishBusyList(
  ctx: CalendarCtx,
  list: Pick<BusyList, "monthKey" | "ranges"> & { createdAt?: number },
): Promise<BusyList> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  const ranges = normalizeBusyRanges(list.ranges);

  const { event } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.publicBusyList,
    tags: busyListToTags({ monthKey: list.monthKey, ranges }),
    content: "",
    // Upstream stamps a plain `now` here. We supersede strictly: a same-second
    // republish that loses NIP-01's lowest-id tie-break silently restores a
    // removed block or drops an added one, and a dropped block is a double
    // booking. The bytes are unchanged, so this stays read-compatible (§9).
    created_at: nextCreatedAt(previousCreatedAtSeconds(list.createdAt)),
  });

  return { user: pubkey, monthKey: list.monthKey, ranges, eventId: event.id, createdAt: event.created_at };
}

/** A user's busy lists for the given months. Months with no list are omitted. */
export async function fetchBusyLists(
  ctx: CalendarCtx,
  pubkey: string,
  monthKeys: string[],
): Promise<BusyList[]> {
  if (monthKeys.length === 0) return [];

  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [CALENDAR_KINDS.publicBusyList],
    authors: [pubkey],
    "#d": monthKeys,
  });

  const lists: BusyList[] = [];
  for (const event of newestByDTag(events).values()) {
    const list = parseBusyListEvent(event);
    if (list) lists.push(list);
  }
  return lists;
}

/**
 * Adds a range to every month it touches.
 *
 * The current lists are re-read first. Publishing from a stale local copy would
 * replace the relay's list with a subset — silently un-blocking time the user
 * already marked busy from another device.
 */
export async function addBusyRange(ctx: CalendarCtx, range: BusyRange): Promise<BusyList[]> {
  if (!Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
    return [];
  }

  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  const monthKeys = busyListMonthKeysForRange(range.start, range.end);
  const existing = await fetchBusyLists(ctx, pubkey, monthKeys);

  const published: BusyList[] = [];
  for (const monthKey of monthKeys) {
    const current = existing.find((list) => list.monthKey === monthKey);
    const ranges = current ? [...current.ranges] : [];
    if (!ranges.some((r) => rangesEqual(r, range))) ranges.push({ ...range });

    published.push(
      await publishBusyList(ctx, { monthKey, ranges, createdAt: current?.createdAt }),
    );
  }
  return published;
}

/** Removes a range by exact `(start, end)` match from every month it touches. */
export async function removeBusyRange(ctx: CalendarCtx, range: BusyRange): Promise<BusyList[]> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  const monthKeys = busyListMonthKeysForRange(range.start, range.end);
  const existing = await fetchBusyLists(ctx, pubkey, monthKeys);

  const published: BusyList[] = [];
  for (const current of existing) {
    const ranges = current.ranges.filter((r) => !rangesEqual(r, range));
    if (ranges.length === current.ranges.length) continue;
    published.push(
      await publishBusyList(ctx, {
        monthKey: current.monthKey,
        ranges,
        createdAt: current.createdAt,
      }),
    );
  }
  return published;
}
