import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import type { CalendarEvent, CalendarEventDraft, NotificationPreference } from "../types";
import { formAttachmentsToTags, parseFormAttachments } from "./formAttachment";
import { frequencyToRrule } from "./recurrence";

/**
 * Calendar-event codec — docs/protocol.md §4 (private, 32678) and §5 (public,
 * 31923). Pure and synchronous: decryption happens in the service layer, which
 * hands the plaintext payload in here.
 *
 * The governing rule is **write narrow, read wide**. Upstream's writers emit a
 * small fixed set of rows; upstream's reader (`nostrEventToCalendar`) accepts a
 * much larger one. Publishing extra rows risks confusing the app; parsing fewer
 * rows silently drops data the app wrote.
 */

/** Explicit `rrule` wins; otherwise the friendly preset is mapped to one. */
export function draftRrule(draft: CalendarEventDraft): string | null {
  if (draft.rrule) return draft.rrule;
  if (draft.repeat) return frequencyToRrule(draft.repeat);
  return null;
}

/**
 * The INNER payload of a private event: the tag rows that get NIP-44 encrypted
 * into `content` under the event's view key. Row order matches upstream's
 * `preparePrivateCalendarEvent` so the two clients produce identical payloads.
 *
 * Two rows are easy to get wrong and both matter:
 *
 * - `image` is **always** emitted, `""` when absent.
 * - `d` is repeated INSIDE the payload. Upstream's `viewPrivateEvent` replaces
 *   the event's tags with this decrypted array and then reads the id from the
 *   `d` row; omit it and every private event collapses under id `""` in
 *   calendar.formstr.app, so only one survives.
 *
 * `start`/`end` are JSON **numbers** here — the public event writes them as
 * decimal strings. That asymmetry is upstream's, and both sides parse with
 * `Number()`, so it is harmless as long as neither side "fixes" it alone.
 */
export function buildPrivateEventPayload(
  draft: CalendarEventDraft,
  authorPubkey: string,
  dTag: string,
): (string | number)[][] {
  const payload: (string | number)[][] = [
    ["title", draft.title],
    ["description", draft.description ?? ""],
    ["start", Math.floor(draft.begin / 1000)],
    ["end", Math.floor(draft.end / 1000)],
    ["image", draft.image ?? ""],
    ["d", dTag],
  ];

  const rrule = draftRrule(draft);
  if (rrule) {
    payload.push(["L", "rrule"], ["l", rrule]);
  }
  if (draft.notificationPreference) {
    payload.push(["notification", draft.notificationPreference]);
  }
  for (const tag of formAttachmentsToTags(draft.forms)) payload.push(tag);
  for (const location of draft.location ?? []) payload.push(["location", location]);

  // The creator's own `p` row always comes first: it is what upstream renders
  // as the organizer, and it is the RSVP-authorization context.
  payload.push(["p", authorPubkey]);
  for (const participant of draft.participants ?? []) payload.push(["p", participant]);

  return payload;
}

/**
 * Outer tags of a public event. Deliberately narrow — no recurrence, no
 * categories, no tzid rows, because upstream's publisher writes none of them
 * (docs/protocol.md §5). The description goes in `content`, not a tag.
 */
export function buildPublicEventTags(draft: CalendarEventDraft, dTag: string): string[][] {
  const tags: string[][] = [
    ["title", draft.title],
    ["d", dTag],
    ["start", String(Math.floor(draft.begin / 1000))],
    ["end", String(Math.floor(draft.end / 1000))],
  ];
  if (draft.image) tags.push(["image", draft.image]);
  for (const location of draft.location ?? []) tags.push(["location", location]);
  for (const participant of draft.participants ?? []) tags.push(["p", participant]);
  return tags;
}

function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * All-day is derived, never stored — mirroring `isAllDayEvent` in upstream's
 * `dateHelper.ts`: both ends land on a local midnight and the event spans at
 * least one whole day.
 */
export function isAllDayEvent(begin: number, end: number): boolean {
  if (!(end > begin)) return false;
  const start = new Date(begin);
  const finish = new Date(end);
  if (start.getHours() !== 0 || start.getMinutes() !== 0) return false;
  if (finish.getHours() !== 0 || finish.getMinutes() !== 0) return false;
  // Round rather than floor: a DST boundary makes a "24 hour" span 23 or 25.
  return Math.round((startOfLocalDay(end) - startOfLocalDay(begin)) / 86_400_000) >= 1;
}

/** Reads the RRULE, accepting every shape either client has ever written. */
export function readRrule(tags: readonly (readonly string[])[]): string | null {
  // Canonical: a NIP-32 label pair — ["L","rrule"] then ["l", <RRULE>]. Take
  // the first `l` AFTER the label, not the first `l` anywhere: a bare search
  // would grab an unrelated label (a language namespace, say) that happens to
  // come first.
  const labelIndex = tags.findIndex((t) => t[0] === "L" && t[1] === "rrule");
  if (labelIndex >= 0) {
    const paired = tags.slice(labelIndex + 1).find((t) => t[0] === "l")?.[1];
    if (paired) return paired;
  }
  // Legacy super-app shape: a self-describing 3-element ["l", <RRULE>, "rrule"].
  const selfLabelled = tags.find((t) => t[0] === "l" && t[2] === "rrule")?.[1];
  if (selfLabelled) return selfLabelled;
  // Oldest shape, a bare ["rrule", <RRULE>].
  return tags.find((t) => t[0] === "rrule")?.[1] ?? null;
}

/**
 * Unix-seconds tag → milliseconds, or `null` when the row is missing or junk.
 *
 * `Number("")` is 0, not NaN, so an empty value has to be treated as missing
 * explicitly. Without the finite check a malformed row yields `NaN`, and an
 * event with a NaN `begin` silently vanishes from every date-range query.
 */
function readTimestampMs(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export interface ParseEventOptions {
  /** nsec view key, recorded on the result so callers can re-encrypt an edit. */
  viewKey?: string;
  /** Relay the event came from, threaded into calendar-list refs on link. */
  relayHint?: string;
  /**
   * Decrypted inner payload for a private event. The service layer decrypts and
   * passes it here, keeping this codec synchronous and signer-free.
   */
  payload?: (string | number)[][];
}

/**
 * Wire event → `CalendarEvent`.
 *
 * For a private event the decrypted `payload` **replaces** the outer tags, as
 * upstream's `viewPrivateEvent` does — the outer tags are only `["d",…]`, and
 * every real field lives in the payload (including its own `d`).
 */
export function parseCalendarEvent(event: Event, options: ParseEventOptions = {}): CalendarEvent {
  const isPrivate = event.kind !== CALENDAR_KINDS.publicEvent;
  const tags: (readonly string[])[] = options.payload
    ? options.payload.map((row) => row.map(String))
    : event.tags;

  const first = (name: string): string | undefined => tags.find((t) => t[0] === name)?.[1];
  const all = (name: string): string[] =>
    tags.filter((t) => t[0] === name && t[1] !== undefined).map((t) => t[1]);

  const beginMs = readTimestampMs(first("start"));
  const endMs = readTimestampMs(first("end"));
  // A malformed or missing timestamp degrades to the event's own created_at
  // rather than NaN, so the event still shows up somewhere the user can see it.
  const begin = beginMs ?? event.created_at * 1000;
  const end = endMs ?? begin + 3_600_000;

  const notification = first("notification");
  const notificationPreference: NotificationPreference | undefined =
    notification === "enabled" || notification === "disabled" ? notification : undefined;

  // Upstream seeds `description` from `content` and lets a `description` row
  // override it. For a private event `content` is ciphertext, never text.
  const descriptionTag = first("description");
  const description = descriptionTag ?? (isPrivate ? "" : (event.content ?? ""));

  const forms = parseFormAttachments(tags);

  return {
    id: first("d") ?? "",
    eventId: event.id,
    kind: event.kind,
    // `name` is the pre-NIP-52 title row; upstream still reads it.
    title: first("title") ?? first("name") ?? "",
    description,
    begin,
    end,
    allDay: isAllDayEvent(begin, end),
    image: first("image") || undefined,
    location: all("location"),
    participants: all("p"),
    categories: all("t"),
    references: all("r"),
    geohashes: all("g"),
    user: event.pubkey,
    isPrivate,
    viewKey: options.viewKey,
    relayHint: options.relayHint,
    repeat: { rrule: readRrule(tags) },
    notificationPreference,
    forms: forms.length > 0 ? forms : undefined,
    createdAt: event.created_at,
    event,
  };
}
