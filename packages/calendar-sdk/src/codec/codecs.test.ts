import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { RSVPStatus, RepeatingFrequency, type BusyList } from "../types";
import {
  busyListMonthKey,
  busyListMonthKeysForRange,
  busyListToTags,
  collectBusyRanges,
  normalizeBusyRanges,
  parseBusyListEvent,
} from "./busyList";
import { decodeCalendarList, encodeCalendarListPayload, lookupViewKey } from "./calendarList";
import { buildEventRef, makeDTag, nextCreatedAt, parseCoordinate, parseEventRef, previousCreatedAtSeconds } from "./identifiers";
import { buildInvitationRumorTags, invitationInboxFilters, parseInvitationRumor, senderDisplayName } from "./invitation";
import { frequencyToRrule, expandOccurrences, isEventInDateRange, normalizeRule } from "./recurrence";
import { buildPublicRsvpTags, latestRsvpPerResponder, parsePublicRsvp, parsePrivateRsvp, rsvpDTag } from "./rsvp";
import { parseFormAttachments } from "./formAttachment";

const AUTHOR = "a".repeat(64);
const ALICE = "b".repeat(64);

function wireEvent(over: Partial<Event> = {}): Event {
  return {
    id: "e".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_800_000_000,
    kind: 1,
    tags: [],
    content: "",
    sig: "f".repeat(128),
    ...over,
  } as Event;
}

describe("identifiers", () => {
  it("truncates the d-tag hash to 30 characters", () => {
    // A 64-char hash is a different d-tag, which is a different event.
    expect(makeDTag("x")).toHaveLength(30);
    expect(makeDTag("x")).toBe(makeDTag("x"));
    expect(makeDTag("x")).not.toBe(makeDTag("y"));
  });

  it("stays strictly ahead of the version it replaces", () => {
    const future = Math.floor(Date.now() / 1000) + 500;
    expect(nextCreatedAt(future)).toBe(future + 1);
    expect(nextCreatedAt(0)).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it("ignores a millisecond timestamp as a previous created_at", () => {
    // Feeding ms into nextCreatedAt stamps the event ~50,000 years ahead and
    // relays drop it.
    expect(previousCreatedAtSeconds(Date.now())).toBe(0);
    expect(previousCreatedAtSeconds(1_800_000_000)).toBe(1_800_000_000);
  });

  it("round-trips an event ref, keeping the relay slot even when empty", () => {
    const ref = buildEventRef({ kind: 32678, authorPubkey: AUTHOR, eventDTag: "d1", viewKey: "nsec1x" });
    expect(ref).toEqual([`32678:${AUTHOR}:d1`, "", "nsec1x"]);
    expect(parseEventRef(ref)).toMatchObject({ kind: 32678, eventDTag: "d1", viewKey: "nsec1x" });
  });

  it("keeps a colon inside a d-tag", () => {
    expect(parseCoordinate(`32678:${AUTHOR}:a:b`)?.dTag).toBe("a:b");
  });

  it("rejects a coordinate that is not one", () => {
    expect(parseCoordinate("nonsense")).toBeNull();
  });
});

describe("calendar list codec", () => {
  const list = {
    title: "Work",
    description: "Office things",
    color: "#ff0000",
    eventRefs: [[`32678:${AUTHOR}:d1`, "wss://r", "nsec1x"]] as [string, string, string][],
  };

  it("writes the description under the content row name", () => {
    // The model says description, the wire says content. Following the model
    // silently drops every description.
    expect(encodeCalendarListPayload(list)).toContainEqual(["content", "Office things"]);
  });

  it("never writes the enabled notification preference", () => {
    expect(
      encodeCalendarListPayload({ ...list, notificationPreference: "enabled" }).some(
        (r) => r[0] === "notifications",
      ),
    ).toBe(false);
    expect(
      encodeCalendarListPayload({ ...list, notificationPreference: "disabled" }),
    ).toContainEqual(["notifications", "disabled"]);
  });

  it("round-trips through decode", () => {
    const payload = encodeCalendarListPayload(list);
    const decoded = decodeCalendarList(wireEvent({ tags: [["d", "cal1"]] }), payload);
    expect(decoded).toMatchObject({
      id: "cal1",
      title: "Work",
      description: "Office things",
      color: "#ff0000",
      eventRefs: [[`32678:${AUTHOR}:d1`, "wss://r", "nsec1x"]],
    });
  });

  it("throws on a payload that is not a tags array", () => {
    // Relays do deliver wrong-kind events into a 32123 subscription; callers
    // catch this and skip rather than losing the stream.
    expect(() => decodeCalendarList(wireEvent(), "")).toThrow(/not a tags array/);
  });

  it("finds the view key for a coordinate across lists", () => {
    const decoded = decodeCalendarList(
      wireEvent({ tags: [["d", "cal1"]] }),
      encodeCalendarListPayload(list),
    );
    expect(lookupViewKey([decoded], `32678:${AUTHOR}:d1`)).toBe("nsec1x");
    expect(lookupViewKey([decoded], `32678:${AUTHOR}:other`)).toBeUndefined();
  });
});

describe("invitation codec", () => {
  const rumor = {
    id: "r".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_800_000_000,
    kind: 14,
    content: "Alice has invited you to an event: Standup.",
    tags: buildInvitationRumorTags({
      participantPubkey: ALICE,
      coordinate: `32678:${AUTHOR}:d1`,
      relayHint: "wss://relay",
      viewKeyNsec: "nsec1x",
      signingNsec: "nsec1y",
    }),
  };

  it("parses a well-formed invitation rumor", () => {
    const invitation = parseInvitationRumor(rumor, "wrap1");
    expect(invitation).toMatchObject({
      giftWrapId: "wrap1",
      senderPubkey: AUTHOR,
      recipientPubkey: ALICE,
      eventId: "d1",
      kind: 32678,
      authorPubkey: AUTHOR,
      viewKey: "nsec1x",
      relayHint: "wss://relay",
      signingNsec: "nsec1y",
    });
  });

  it("returns null for a rumor that is not a calendar invitation", () => {
    // A 1059 inbox legitimately carries other apps' traffic; one foreign wrap
    // must not abort the whole read.
    expect(parseInvitationRumor({ ...rumor, tags: [["p", ALICE]] }, "wrap1")).toBeNull();
  });

  it("returns null when the view key is missing", () => {
    expect(
      parseInvitationRumor({ ...rumor, tags: [["a", `32678:${AUTHOR}:d1`]] }, "wrap1"),
    ).toBeNull();
  });

  it("treats a missing signing_nsec as optional, not fatal", () => {
    const legacy = { ...rumor, tags: rumor.tags.filter((t) => t[0] !== "signing_nsec") };
    expect(parseInvitationRumor(legacy, "wrap1")?.signingNsec).toBeUndefined();
  });

  it("queries kind 1059 narrowed by the k discriminator", () => {
    expect(invitationInboxFilters({ pubkeys: [ALICE] })).toEqual([
      { kinds: [1059], "#p": [ALICE], "#k": ["1052"] },
    ]);
  });

  it("prefers display_name, then name, then a truncated npub", () => {
    expect(senderDisplayName(JSON.stringify({ display_name: "Ada", name: "ada" }), AUTHOR)).toBe("Ada");
    expect(senderDisplayName(JSON.stringify({ name: "ada" }), AUTHOR)).toBe("ada");
    expect(senderDisplayName("not json", AUTHOR)).toMatch(/^npub1/);
    expect(senderDisplayName(undefined, AUTHOR)).toHaveLength(12);
  });
});

describe("rsvp codec", () => {
  it("derives a d-tag deterministic per responder and event", () => {
    const a = rsvpDTag(ALICE, AUTHOR, "d1");
    expect(a).toBe(rsvpDTag(ALICE, AUTHOR, "d1"));
    expect(a).not.toBe(rsvpDTag(ALICE, AUTHOR, "d2"));
  });

  it("omits the relay slot rather than writing an empty one", () => {
    // ["a", coord, ""] is a different tag than ["a", coord].
    const tags = buildPublicRsvpTags({
      coordinate: `31923:${AUTHOR}:d1`,
      dTag: "r1",
      payload: { status: RSVPStatus.accepted },
    });
    expect(tags[0]).toEqual(["a", `31923:${AUTHOR}:d1`]);
  });

  it("puts the comment in content for a public RSVP", () => {
    const event = wireEvent({
      kind: 31925,
      content: "See you there",
      tags: buildPublicRsvpTags({
        coordinate: `31923:${AUTHOR}:d1`,
        dTag: "r1",
        payload: { status: RSVPStatus.tentative, suggestedStart: 1_800_000_000 },
      }),
    });
    expect(parsePublicRsvp(event)).toMatchObject({
      status: RSVPStatus.tentative,
      suggestedStart: 1_800_000_000,
      comment: "See you there",
    });
  });

  it("rejects a status the protocol does not define", () => {
    const event = wireEvent({ kind: 31925, tags: [["a", "x:y:z"], ["status", "pending"]] });
    expect(parsePublicRsvp(event)).toBeNull();
  });

  it("reads a private RSVP from its decrypted payload", () => {
    const event = wireEvent({ kind: 32069, tags: [["a", `32678:${AUTHOR}:d1`], ["d", "r1"]] });
    expect(parsePrivateRsvp(event, { status: "accepted", comment: "yes" })).toMatchObject({
      status: RSVPStatus.accepted,
      comment: "yes",
      eventCoord: `32678:${AUTHOR}:d1`,
    });
  });

  it("keeps only the newest answer per responder", () => {
    const base = { status: RSVPStatus.accepted, comment: "", eventCoord: "x:y:z" };
    const latest = latestRsvpPerResponder([
      { ...base, pubkey: ALICE, createdAt: 10 },
      { ...base, pubkey: ALICE, createdAt: 20 },
      { ...base, pubkey: AUTHOR, createdAt: 5 },
    ]);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.pubkey === ALICE)?.createdAt).toBe(20);
  });
});

describe("busy list codec", () => {
  const april = Date.UTC(2026, 3, 10, 9, 0, 0);

  it("keys months in UTC", () => {
    expect(busyListMonthKey(april)).toBe("2026-04");
  });

  it("returns every month a range touches", () => {
    expect(busyListMonthKeysForRange(Date.UTC(2026, 3, 30), Date.UTC(2026, 5, 2))).toEqual([
      "2026-04",
      "2026-05",
      "2026-06",
    ]);
  });

  it("round-trips through tags", () => {
    const list: Pick<BusyList, "monthKey" | "ranges"> = {
      monthKey: "2026-04",
      ranges: [{ start: april, end: april + 3_600_000 }],
    };
    const event = wireEvent({ kind: 31926, tags: busyListToTags(list), content: "" });
    expect(event.tags).toContainEqual(["t", "busy"]);
    expect(parseBusyListEvent(event)).toMatchObject(list);
  });

  it("rejects an event whose d-tag is not a month key", () => {
    expect(parseBusyListEvent(wireEvent({ kind: 31926, tags: [["d", "not-a-month"]] }))).toBeNull();
  });

  it("drops inverted and non-finite ranges, and dedupes exact repeats", () => {
    expect(
      normalizeBusyRanges([
        { start: 20, end: 10 },
        { start: Number.NaN, end: 5 },
        { start: 10, end: 20 },
        { start: 10, end: 20 },
      ]),
    ).toEqual([{ start: 10, end: 20 }]);
  });

  it("collects only ranges overlapping the window", () => {
    const list: BusyList = {
      user: AUTHOR,
      monthKey: "2026-04",
      ranges: [
        { start: 0, end: 100 },
        { start: 500, end: 600 },
      ],
      eventId: "",
      createdAt: 0,
    };
    expect(collectBusyRanges([list], 50, 200)).toEqual([{ start: 0, end: 100 }]);
  });
});

describe("recurrence", () => {
  it("maps the friendly presets", () => {
    expect(frequencyToRrule(RepeatingFrequency.Quarterly)).toBe("FREQ=MONTHLY;INTERVAL=3");
    expect(frequencyToRrule(RepeatingFrequency.None)).toBeNull();
  });

  it("accepts a rule with or without the RRULE: prefix", () => {
    expect(normalizeRule("RRULE:FREQ=DAILY")).toBe("FREQ=DAILY");
  });

  it("expands daily occurrences preserving duration", () => {
    const begin = Date.UTC(2026, 3, 1, 9, 0, 0);
    const event = { begin, end: begin + 1_800_000, repeat: { rrule: "FREQ=DAILY" } };
    const occurrences = expandOccurrences(event, begin, begin + 3 * 86_400_000);
    expect(occurrences).toHaveLength(4);
    expect(occurrences[1].begin - occurrences[0].begin).toBe(86_400_000);
    expect(occurrences[0].end - occurrences[0].begin).toBe(1_800_000);
  });

  it("finds an occurrence that started before the window and runs into it", () => {
    const begin = Date.UTC(2026, 3, 1, 23, 0, 0);
    const event = { begin, end: begin + 7_200_000, repeat: { rrule: "FREQ=DAILY" } };
    const nextDayMorning = Date.UTC(2026, 3, 2, 0, 30, 0);
    expect(isEventInDateRange(event, nextDayMorning, nextDayMorning + 60_000)).toBe(true);
  });

  it("handles a non-recurring event by plain overlap", () => {
    const event = { begin: 100, end: 200, repeat: { rrule: null } };
    expect(isEventInDateRange(event, 150, 300)).toBe(true);
    expect(isEventInDateRange(event, 300, 400)).toBe(false);
  });
});

describe("form attachments", () => {
  it("reads the view key from the same row, not the next one", () => {
    expect(
      parseFormAttachments([
        ["form", "naddr1a", "vk-a"],
        ["form", "naddr1b"],
      ]),
    ).toEqual([{ naddr: "naddr1a", viewKey: "vk-a" }, { naddr: "naddr1b" }]);
  });

  it("skips a form row with no naddr", () => {
    expect(parseFormAttachments([["form", ""]])).toEqual([]);
  });
});
