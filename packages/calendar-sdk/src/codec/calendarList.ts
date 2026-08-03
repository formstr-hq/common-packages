import type { Event } from "nostr-tools";

import type { CalendarList, EventRef } from "../types";

/**
 * Private calendar list codec (kind 32123) — docs/protocol.md §7. Mirrors
 * `encryptCalendarList` / `decryptCalendarList` in nostr-calendar's
 * `src/nostr/calendars.ts`.
 *
 * The outer event carries only `["d", calendarId]`; everything else is a tags
 * array encrypted to the owner's own pubkey through their signer, so the list
 * — and every view key in it — stays private even on a public relay.
 */

export const DEFAULT_CALENDAR_COLOR = "#4285f4";
export const DEFAULT_CALENDAR_TITLE = "My Calendar";

/**
 * The inner payload. Note the row name is `content`, not `description` — the
 * models diverge here and following the model instead of the wire silently
 * drops every description.
 *
 * `["notifications","enabled"]` is deliberately never written: upstream only
 * persists the non-default value, and absence means enabled.
 */
export function encodeCalendarListPayload(
  list: Pick<
    CalendarList,
    "title" | "description" | "color" | "notificationPreference" | "eventRefs"
  >,
): string[][] {
  const payload: string[][] = [
    ["title", list.title],
    ["content", list.description],
    ["color", list.color],
  ];
  if (list.notificationPreference === "disabled") {
    payload.push(["notifications", "disabled"]);
  }
  for (const ref of list.eventRefs) {
    payload.push(["a", ...ref]);
  }
  return payload;
}

/**
 * Decrypted payload + the outer event → `CalendarList`.
 *
 * Throws when the payload is not a tags array. That happens for real: relays
 * occasionally deliver a wrong-kind event into a 32123 subscription (a 31926
 * busy list has a similar d-tag shape and empty content), so callers catch and
 * skip rather than letting one bad event kill the stream.
 */
export function decodeCalendarList(event: Event, payload: unknown): CalendarList {
  if (!Array.isArray(payload)) {
    throw new Error(`Calendar list payload is not a tags array (got ${typeof payload})`);
  }

  let title = DEFAULT_CALENDAR_TITLE;
  let description = "";
  let color = DEFAULT_CALENDAR_COLOR;
  let notificationPreference: CalendarList["notificationPreference"];
  const eventRefs: EventRef[] = [];

  for (const tag of payload as unknown[]) {
    if (!Array.isArray(tag) || tag.length === 0) continue;
    const row = tag as string[];
    switch (row[0]) {
      case "title":
        title = row[1] ?? DEFAULT_CALENDAR_TITLE;
        break;
      case "content":
        description = row[1] || "";
        break;
      case "color":
        color = row[1] || DEFAULT_CALENDAR_COLOR;
        break;
      case "notifications":
        notificationPreference = row[1] === "disabled" ? "disabled" : "enabled";
        break;
      case "a":
        // ["a", coordinate, relayUrl, viewKey] → the positional ref triple.
        // relayUrl and viewKey are read by position, so a missing relay hint is
        // "" and never omitted.
        if (row[1]) eventRefs.push([row[1], row[2] ?? "", row[3] ?? ""]);
        break;
    }
  }

  return {
    id: event.tags.find((t) => t[0] === "d")?.[1] ?? "",
    eventId: event.id,
    title,
    description,
    color,
    notificationPreference,
    eventRefs,
    createdAt: event.created_at,
  };
}

/** The calendar list currently holding `coordinate`, if any. */
export function findCalendarForCoordinate(
  lists: readonly CalendarList[],
  coordinate: string,
): CalendarList | undefined {
  return lists.find((list) => list.eventRefs.some((ref) => ref[0] === coordinate));
}

/** The view key recorded for `coordinate` across every list, if any. */
export function lookupViewKey(
  lists: readonly CalendarList[],
  coordinate: string,
): string | undefined {
  for (const list of lists) {
    const ref = list.eventRefs.find((r) => r[0] === coordinate);
    if (ref?.[2]) return ref[2];
  }
  return undefined;
}
