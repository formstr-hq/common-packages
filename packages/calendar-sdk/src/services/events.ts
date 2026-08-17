import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import { ViewKeyRequiredError, type CalendarCtx } from "../contracts";
import type { CalendarEvent, CalendarEventDraft, CalendarList, EventRef } from "../types";
import {
  buildPrivateEventPayload,
  buildPublicEventTags,
  parseCalendarEvent,
} from "../codec/event";
import {
  buildEventRef,
  coordinate as makeCoordinate,
  makeDTag,
  nextCreatedAt,
  parseCoordinate,
  previousCreatedAtSeconds,
} from "../codec/identifiers";
import { decodeViewKey, encodeViewKey, generateViewKey } from "../crypto/viewKey";
import { selfDecrypt, selfEncrypt } from "../crypto/nip44";
import { newestByCoordinate } from "../discovery/dedupe";
import { buildDeletionTags } from "../discovery/deletions";
import { normalizeRelayList } from "../discovery/relays";
import { fetchCalendars, linkEventToCalendar, lookupEventViewKey } from "./calendars";
import { sendInvitations } from "./invitations";
import { signAndPublish } from "./publish";

/**
 * Calendar events — docs/protocol.md §4 (private) and §5 (public).
 */

export interface PublishPrivateEventOptions {
  /** Calendar list to link the event into. Strongly recommended: the list ref
   *  is the only durable record of the view key. */
  calendarId?: string;
  /** Reuse an existing view key (nsec) instead of minting one. */
  viewKey?: string;
  /** Reuse a pre-agreed d-tag, e.g. one a booker generated in advance. */
  dTag?: string;
  /** `created_at` of the version being replaced, so the new one supersedes it. */
  previousCreatedAt?: number;
  /** Extra plaintext tags on the invitation wraps. */
  invitationWrapTags?: string[][];
  /** Skip sending invitations entirely. */
  skipInvitations?: boolean;
  /** Pre-fetched calendar lists, to avoid a second round trip. */
  calendars?: readonly CalendarList[];
}

export interface UpdatePrivateEventOptions extends PublishPrivateEventOptions {
  /**
   * Participants who already hold an invitation and must not get another.
   *
   * Required, not optional: an omitted list re-wraps everyone on the event, so
   * a forced resend has to be a decision (`[]`), never a forgotten argument.
   */
  previousParticipants: string[];
}

export interface PublishedEvent {
  event: CalendarEvent;
  signedEvent: Event;
  eventRef: EventRef;
  viewKey: string;
  invitations: Event[];
  relayHint: string;
}

/**
 * Publishes a private event and invites its participants.
 *
 * The view key is generated per event and is never the identity key. On an
 * edit the SAME key must be reused — see `updatePrivateEvent`, which is the
 * safe entry point for that.
 */
export async function publishPrivateEvent(
  ctx: CalendarCtx,
  draft: CalendarEventDraft,
  // `previousParticipants` is only meaningful on an edit, so it is not on the
  // public options — `updatePrivateEvent` forwards it through here.
  options: PublishPrivateEventOptions & { previousParticipants?: string[] } = {},
): Promise<PublishedEvent> {
  const signer = await ctx.getSigner();
  const authorPubkey = await signer.getPublicKey();

  const viewKey = options.viewKey
    ? { secretKey: decodeViewKey(options.viewKey), nsec: options.viewKey }
    : generateViewKey();

  const dTag =
    options.dTag ?? draft.id ?? makeDTag(`${JSON.stringify(draft)}-${Date.now()}`);

  const payload = buildPrivateEventPayload(draft, authorPubkey, dTag);

  const { event: signedEvent, relayHint } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.privateEvent,
    // Outer tags are exactly ["d", …]; an outer `p` row would leak the guest list.
    tags: [["d", dTag]],
    content: selfEncrypt(viewKey.secretKey, payload),
    created_at: nextCreatedAt(previousCreatedAtSeconds(options.previousCreatedAt)),
  });

  const coordinate = makeCoordinate(CALENDAR_KINDS.privateEvent, authorPubkey, dTag);
  const eventRef = buildEventRef({
    kind: CALENDAR_KINDS.privateEvent,
    authorPubkey,
    eventDTag: dTag,
    relayUrl: relayHint,
    viewKey: viewKey.nsec,
  });

  // Only participants who are new to this version get a wrap. Re-inviting
  // everyone on every edit spams the inbox of people who already accepted —
  // which is why the edit path requires the list rather than defaulting it.
  const alreadyInvited = new Set(options.previousParticipants ?? []);
  const newParticipants = (draft.participants ?? []).filter((p) => !alreadyInvited.has(p));

  const invitations = options.skipInvitations
    ? []
    : await sendInvitations(ctx, {
        participants: newParticipants,
        authorPubkey,
        coordinate,
        dTag,
        eventKind: CALENDAR_KINDS.privateEvent,
        eventTitle: draft.title,
        viewKeyNsec: viewKey.nsec,
        relayHint,
        wrapTags: options.invitationWrapTags,
      });

  if (options.calendarId) {
    const calendars = options.calendars ?? (await fetchCalendars(ctx));
    const list = calendars.find((c) => c.id === options.calendarId);
    // A calendarId that does not resolve is a caller error, but dropping the
    // link silently would strand the view key. Surface it.
    if (!list) {
      throw new Error(
        `Calendar list ${options.calendarId} not found — the event was published but its view key is not recorded anywhere.`,
      );
    }
    await linkEventToCalendar(ctx, list, eventRef);
  }

  return {
    event: parseCalendarEvent(signedEvent, { payload, viewKey: viewKey.nsec, relayHint }),
    signedEvent,
    eventRef,
    viewKey: viewKey.nsec,
    invitations,
    relayHint,
  };
}

/**
 * Edits a private event, keeping its identity and its key.
 *
 * The view key is resolved in this order: the one passed in, the one already on
 * the event, then the one recorded in the caller's calendar-list refs. If none
 * resolves this throws rather than minting a fresh key — a rotated key leaves
 * the event permanently unreadable to everyone already invited, and the ref
 * still points at the old one.
 */
export async function updatePrivateEvent(
  ctx: CalendarCtx,
  draft: CalendarEventDraft & { id: string },
  options: UpdatePrivateEventOptions,
): Promise<PublishedEvent> {
  const signer = await ctx.getSigner();
  const authorPubkey = await signer.getPublicKey();
  const coordinate = makeCoordinate(CALENDAR_KINDS.privateEvent, authorPubkey, draft.id);

  const viewKey =
    options.viewKey ?? (await lookupEventViewKey(ctx, coordinate, options.calendars));
  if (!viewKey) throw new ViewKeyRequiredError(coordinate);

  return publishPrivateEvent(ctx, draft, { ...options, viewKey, dTag: draft.id });
}

export async function publishPublicEvent(
  ctx: CalendarCtx,
  draft: CalendarEventDraft,
  options: { previousCreatedAt?: number } = {},
): Promise<{ event: CalendarEvent; signedEvent: Event; relayHint: string }> {
  const dTag = draft.id ?? crypto.randomUUID();

  const { event: signedEvent, relayHint } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.publicEvent,
    tags: buildPublicEventTags(draft, dTag),
    // Plaintext description, not JSON — upstream reads `content` as the
    // description when no `description` row is present.
    content: draft.description ?? "",
    created_at: nextCreatedAt(previousCreatedAtSeconds(options.previousCreatedAt)),
  });

  return {
    event: parseCalendarEvent(signedEvent, { relayHint }),
    signedEvent,
    relayHint,
  };
}

/** Decrypts a private event's payload, or returns null when the key is wrong. */
function decryptPayload(event: Event, viewKeyNsec: string): (string | number)[][] | null {
  try {
    const payload = selfDecrypt<unknown>(decodeViewKey(viewKeyNsec), event.content);
    return Array.isArray(payload) ? (payload as (string | number)[][]) : null;
  } catch {
    return null;
  }
}

/**
 * Parses a wire event, decrypting it when a view key is available.
 *
 * Decryption never touches the signer: the view key is local, so reading N
 * events costs zero signer round trips.
 */
export function parseEvent(
  event: Event,
  options: { viewKey?: string; relayHint?: string } = {},
): CalendarEvent {
  if (event.kind === CALENDAR_KINDS.publicEvent || !options.viewKey) {
    return parseCalendarEvent(event, options);
  }
  const payload = decryptPayload(event, options.viewKey);
  return parseCalendarEvent(event, { ...options, payload: payload ?? undefined });
}

/**
 * Fetches one event by coordinate.
 *
 * No `limit` on the filter: it would cap to the author's newest events rather
 * than this d-tag on relays that apply the limit before the tag filter.
 */
export async function fetchEventByCoordinate(
  ctx: CalendarCtx,
  coordinate: string,
  options: { viewKey?: string; relays?: string[] } = {},
): Promise<CalendarEvent | null> {
  const parsed = parseCoordinate(coordinate);
  if (!parsed) return null;

  const relays = normalizeRelayList([...(options.relays ?? []), ...ctx.relays]);
  const events = await ctx.runtime.querySync(relays, {
    kinds: [parsed.kind],
    authors: [parsed.authorPubkey],
    "#d": [parsed.dTag],
  });

  const winner = newestByCoordinate(events).get(coordinate);
  if (!winner) return null;
  return parseEvent(winner, { viewKey: options.viewKey, relayHint: options.relays?.[0] });
}

/**
 * Every event referenced by the given calendar lists, decrypted with the view
 * key each ref carries.
 *
 * Refs are grouped into one query per author so a calendar of 200 events is a
 * handful of round trips rather than 200.
 */
export async function fetchEventsFromCalendars(
  ctx: CalendarCtx,
  lists: readonly CalendarList[],
): Promise<CalendarEvent[]> {
  const byAuthor = new Map<string, { dTags: Set<string>; kinds: Set<number> }>();
  const viewKeys = new Map<string, string>();
  const relayHints = new Map<string, string>();

  for (const list of lists) {
    for (const ref of list.eventRefs) {
      const parsed = parseCoordinate(ref[0]);
      if (!parsed) continue;
      const entry = byAuthor.get(parsed.authorPubkey) ?? { dTags: new Set(), kinds: new Set() };
      entry.dTags.add(parsed.dTag);
      entry.kinds.add(parsed.kind);
      byAuthor.set(parsed.authorPubkey, entry);
      if (ref[2]) viewKeys.set(ref[0], ref[2]);
      if (ref[1]) relayHints.set(ref[0], ref[1]);
    }
  }

  const collected: Event[] = [];
  for (const [author, entry] of byAuthor) {
    const relays = normalizeRelayList([...relayHints.values(), ...ctx.relays]);
    collected.push(
      ...(await ctx.runtime.querySync(relays, {
        kinds: [...entry.kinds],
        authors: [author],
        "#d": [...entry.dTags],
      })),
    );
  }

  const events: CalendarEvent[] = [];
  for (const [coordinate, winner] of newestByCoordinate(collected)) {
    events.push(
      parseEvent(winner, {
        viewKey: viewKeys.get(coordinate),
        relayHint: relayHints.get(coordinate),
      }),
    );
  }
  return events;
}

/** Public events in a time window. */
export async function fetchPublicEvents(
  ctx: CalendarCtx,
  options: { since?: number; until?: number; authors?: string[]; limit?: number } = {},
): Promise<CalendarEvent[]> {
  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [CALENDAR_KINDS.publicEvent],
    ...(options.authors && { authors: options.authors }),
    ...(options.since !== undefined && { since: options.since }),
    ...(options.until !== undefined && { until: options.until }),
    ...(options.limit !== undefined && { limit: options.limit }),
  });
  return [...newestByCoordinate(events).values()].map((event) => parseEvent(event));
}

/** NIP-09 deletion request for an event the caller authored. */
export async function deleteEvent(
  ctx: CalendarCtx,
  target: { coordinate?: string; eventId?: string; kind: number; reason?: string },
): Promise<Event> {
  const { event } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.deletion,
    content: target.reason ?? "",
    created_at: Math.floor(Date.now() / 1000),
    tags: buildDeletionTags({
      eventIds: target.eventId ? [target.eventId] : [],
      coordinates: target.coordinate ? [target.coordinate] : [],
      kinds: [target.kind],
    }),
  });
  return event;
}
