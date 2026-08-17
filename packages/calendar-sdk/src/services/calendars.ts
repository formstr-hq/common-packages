import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import { CalendarNotFoundError, type CalendarCtx } from "../contracts";
import type { CalendarList, EventRef } from "../types";
import {
  decodeCalendarList,
  encodeCalendarListPayload,
  lookupViewKey,
} from "../codec/calendarList";
import { makeDTag, nextCreatedAt, previousCreatedAtSeconds } from "../codec/identifiers";
import { buildDeletionTags } from "../discovery/deletions";
import { newestByDTag } from "../discovery/dedupe";
import { signAndPublish } from "./publish";

/**
 * Calendar lists (kind 32123) — docs/protocol.md §7.
 *
 * A list is the owner's private index of which events belong to which calendar,
 * and — critically — the only durable record of each private event's view key.
 * Lose the ref and the event is unreadable forever.
 */

async function encryptToSelf(ctx: CalendarCtx, payload: string[][]): Promise<string> {
  const signer = await ctx.getSigner();
  return signer.nip44Encrypt(await signer.getPublicKey(), JSON.stringify(payload));
}

async function decryptOwn(ctx: CalendarCtx, event: Event): Promise<unknown> {
  const signer = await ctx.getSigner();
  return JSON.parse(await signer.nip44Decrypt(event.pubkey, event.content)) as unknown;
}

export async function publishCalendarList(
  ctx: CalendarCtx,
  list: CalendarList,
): Promise<CalendarList> {
  const { event } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.calendarList,
    content: await encryptToSelf(ctx, encodeCalendarListPayload(list)),
    created_at: nextCreatedAt(previousCreatedAtSeconds(list.createdAt)),
    tags: [["d", list.id]],
  });

  return { ...list, eventId: event.id, createdAt: event.created_at };
}

/** Title is the caller's; so is the colour, which is written blank when unset. */
export async function createCalendar(
  ctx: CalendarCtx,
  input: {
    title: string;
    description?: string;
    color?: string;
    notificationPreference?: CalendarList["notificationPreference"];
  },
): Promise<CalendarList> {
  const draft: CalendarList = {
    id: makeDTag(`${JSON.stringify(input)}-${Date.now()}`),
    eventId: "",
    title: input.title,
    description: input.description ?? "",
    color: input.color ?? "",
    notificationPreference: input.notificationPreference,
    eventRefs: [],
    createdAt: 0,
  };
  return publishCalendarList(ctx, draft);
}

/**
 * Every calendar list the caller owns.
 *
 * A list that fails to decrypt or decode is skipped rather than thrown: relays
 * do deliver wrong-kind events into a 32123 subscription, and one bad event
 * must not cost the user every other calendar they have.
 */
export async function fetchCalendars(ctx: CalendarCtx): Promise<CalendarList[]> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();

  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [CALENDAR_KINDS.calendarList],
    authors: [pubkey],
  });

  const lists: CalendarList[] = [];
  // Serial, not Promise.all: external signers (nos2x-fox, Amber) reject
  // concurrent nip44_decrypt calls while their permission prompt is open.
  for (const event of newestByDTag(events.filter((e) => e.kind === CALENDAR_KINDS.calendarList)).values()) {
    try {
      lists.push(decodeCalendarList(event, await decryptOwn(ctx, event)));
    } catch {
      // Undecryptable or malformed — not ours, or not a calendar list.
    }
  }
  return lists;
}

export async function deleteCalendar(ctx: CalendarCtx, list: CalendarList): Promise<void> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();

  await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.deletion,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: buildDeletionTags({
      coordinates: [`${CALENDAR_KINDS.calendarList}:${pubkey}:${list.id}`],
      eventIds: list.eventId ? [list.eventId] : [],
      kinds: [CALENDAR_KINDS.calendarList],
    }),
  });
}

/** Adds a ref, replacing any existing entry for the same coordinate. */
export async function linkEventToCalendar(
  ctx: CalendarCtx,
  list: CalendarList,
  ref: EventRef,
): Promise<CalendarList> {
  const existing = list.eventRefs.find((r) => r[0] === ref[0]);
  // Replace rather than skip: a key rotation changes the ref's third element
  // while the coordinate stays the same, and keeping the old entry would leave
  // the list pointing at a key that no longer decrypts the event.
  if (existing && existing[1] === ref[1] && existing[2] === ref[2]) return list;

  const eventRefs: EventRef[] = [...list.eventRefs.filter((r) => r[0] !== ref[0]), ref];
  return publishCalendarList(ctx, { ...list, eventRefs });
}

export async function unlinkEventFromCalendar(
  ctx: CalendarCtx,
  list: CalendarList,
  coordinate: string,
): Promise<CalendarList> {
  const eventRefs = list.eventRefs.filter((r) => r[0] !== coordinate);
  if (eventRefs.length === list.eventRefs.length) return list;
  return publishCalendarList(ctx, { ...list, eventRefs });
}

/**
 * Moves an event between lists.
 *
 * The destination is published FIRST, so a failure between the two writes
 * leaves the event in both lists rather than in neither — a duplicate is
 * recoverable, a lost view key is not.
 */
export async function moveEventBetweenCalendars(
  ctx: CalendarCtx,
  lists: readonly CalendarList[],
  targetCalendarId: string,
  ref: EventRef,
): Promise<{ source?: CalendarList; target: CalendarList }> {
  const target = lists.find((list) => list.id === targetCalendarId);
  if (!target) throw new CalendarNotFoundError(targetCalendarId);

  const source = lists.find(
    (list) => list.id !== targetCalendarId && list.eventRefs.some((r) => r[0] === ref[0]),
  );

  const updatedTarget = await linkEventToCalendar(ctx, target, ref);
  const updatedSource = source
    ? await unlinkEventFromCalendar(ctx, source, ref[0])
    : undefined;

  return { source: updatedSource, target: updatedTarget };
}

/**
 * The view key recorded for a coordinate in any of the caller's lists.
 *
 * This is the recovery path that makes an edit safe: a caller who no longer
 * holds the key in memory must NOT mint a fresh one, or the event becomes
 * permanently unreadable to everyone who was already invited.
 */
export async function lookupEventViewKey(
  ctx: CalendarCtx,
  coordinate: string,
  lists?: readonly CalendarList[],
): Promise<string | undefined> {
  return lookupViewKey(lists ?? (await fetchCalendars(ctx)), coordinate);
}
