import { RRule } from "rrule";

import { RepeatingFrequency } from "../types";

/**
 * Recurrence, mirroring nostr-calendar's `src/utils/repeatingEventsHelper.ts`.
 *
 * On the wire recurrence is a NIP-32 label pair on the event —
 * `["L","rrule"]` immediately followed by `["l", <RRULE>]` — see
 * docs/protocol.md §4. This module only deals with the RRULE string itself.
 *
 * **Expansion is UTC-only and ignores `start_tzid`**, exactly as upstream does
 * (docs/protocol.md §12.5). That is a real limitation, and it is kept
 * deliberately: a tzid-aware expansion here would compute different occurrence
 * times than the app showing the user the same event.
 */

const RRULE_PREFIX = /^RRULE:/i;
const WEEKDAY_RULE = "MO,TU,WE,TH,FR";

const FREQUENCY_TO_RRULE: Record<RepeatingFrequency, string | null> = {
  [RepeatingFrequency.None]: null,
  [RepeatingFrequency.Daily]: "FREQ=DAILY",
  [RepeatingFrequency.Weekly]: "FREQ=WEEKLY",
  [RepeatingFrequency.Weekday]: `FREQ=WEEKLY;BYDAY=${WEEKDAY_RULE}`,
  [RepeatingFrequency.Monthly]: "FREQ=MONTHLY",
  [RepeatingFrequency.Quarterly]: "FREQ=MONTHLY;INTERVAL=3",
  [RepeatingFrequency.Yearly]: "FREQ=YEARLY",
};

/** Strips a leading `RRULE:` so both `FREQ=…` and `RRULE:FREQ=…` are accepted. */
export function normalizeRule(rule: string): string {
  return rule.replace(RRULE_PREFIX, "").trim();
}

export function frequencyToRrule(freq: RepeatingFrequency): string | null {
  return FREQUENCY_TO_RRULE[freq] ?? null;
}

export function rruleToFrequency(rule: string): RepeatingFrequency | null {
  const normalized = normalizeRule(rule);
  for (const [freq, mapped] of Object.entries(FREQUENCY_TO_RRULE)) {
    if (mapped && mapped === normalized) return freq as RepeatingFrequency;
  }
  return null;
}

/**
 * `DTSTART` is written as a compact UTC stamp, byte-identical to upstream's
 * `parseRRule`. Changing the format changes which occurrences `rrule` produces.
 */
function buildRule(rrule: string, dtstart: Date): RRule {
  const stamp = dtstart.toISOString().replace(/[-:]/g, "").split(".")[0];
  return RRule.fromString(`DTSTART:${stamp}Z\nRRULE:${normalizeRule(rrule)}`);
}

export interface Occurrence {
  /** Milliseconds since epoch. */
  begin: number;
  /** Milliseconds since epoch. */
  end: number;
}

/**
 * Every occurrence start within `[rangeStart, rangeEnd]` (ms), inclusive.
 * A non-recurring event yields its own start when it falls in the range.
 */
export function occurrenceStartsInRange(
  event: { begin: number; repeat?: { rrule: string | null } },
  rangeStart: number,
  rangeEnd: number,
): number[] {
  const { begin } = event;
  const rrule = event.repeat?.rrule;
  if (!rrule) {
    return begin >= rangeStart && begin <= rangeEnd ? [begin] : [];
  }
  return buildRule(rrule, new Date(begin))
    .between(new Date(Math.max(begin, rangeStart)), new Date(rangeEnd), true)
    .map((occurrence) => occurrence.getTime());
}

/** Occurrences as `{begin, end}` pairs, preserving the event's duration. */
export function expandOccurrences(
  event: { begin: number; end: number; repeat?: { rrule: string | null } },
  rangeStart: number,
  rangeEnd: number,
): Occurrence[] {
  const duration = event.end - event.begin;
  return occurrenceStartsInRange(event, rangeStart, rangeEnd).map((begin) => ({
    begin,
    end: begin + duration,
  }));
}

/**
 * Whether any occurrence of the event overlaps `[rangeStart, rangeEnd]` (ms).
 *
 * An occurrence overlaps when `start <= rangeEnd && end >= rangeStart`, so the
 * search has to start a full duration BEFORE the range — an event that began
 * yesterday and runs through today still belongs on today's calendar.
 */
export function isEventInDateRange(
  event: { begin: number; end: number; repeat?: { rrule: string | null } },
  rangeStart: number,
  rangeEnd: number,
): boolean {
  const { begin, end } = event;
  const duration = end - begin;
  const rrule = event.repeat?.rrule;

  if (!rrule) {
    return (
      (begin >= rangeStart && begin <= rangeEnd) ||
      (end >= rangeStart && end <= rangeEnd) ||
      (begin <= rangeStart && end >= rangeEnd)
    );
  }

  const occurrences = buildRule(rrule, new Date(begin)).between(
    new Date(Math.max(begin, rangeStart - duration)),
    new Date(rangeEnd),
    true,
  );

  return occurrences.some((occurrence) => {
    const occStart = occurrence.getTime();
    return occStart <= rangeEnd && occStart + duration >= rangeStart;
  });
}
