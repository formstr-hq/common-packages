import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import { RepeatingFrequency, type CalendarEventDraft } from "../types";
import {
  buildPrivateEventPayload,
  buildPublicEventTags,
  isAllDayEvent,
  parseCalendarEvent,
  readRrule,
} from "./event";

const AUTHOR = "a".repeat(64);
const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);

const draft = (over: Partial<CalendarEventDraft> = {}): CalendarEventDraft => ({
  title: "Standup",
  description: "Daily sync",
  begin: 1_800_000_000_000,
  end: 1_800_003_600_000,
  ...over,
});

function wireEvent(over: Partial<Event> = {}): Event {
  return {
    id: "e".repeat(64),
    pubkey: AUTHOR,
    created_at: 1_800_000_000,
    kind: CALENDAR_KINDS.privateEvent,
    tags: [],
    content: "",
    sig: "f".repeat(128),
    ...over,
  } as Event;
}

describe("buildPrivateEventPayload", () => {
  it("emits upstream's row order", () => {
    const payload = buildPrivateEventPayload(draft(), AUTHOR, "d1");
    expect(payload.map((r) => r[0])).toEqual([
      "title",
      "description",
      "start",
      "end",
      "image",
      "d",
      "p",
    ]);
  });

  it("writes start and end as JSON numbers, in seconds", () => {
    const payload = buildPrivateEventPayload(draft(), AUTHOR, "d1");
    expect(payload.find((r) => r[0] === "start")?.[1]).toBe(1_800_000_000);
    expect(payload.find((r) => r[0] === "end")?.[1]).toBe(1_800_003_600);
    expect(typeof payload.find((r) => r[0] === "start")?.[1]).toBe("number");
  });

  it("always writes an image row, empty when there is no image", () => {
    expect(buildPrivateEventPayload(draft(), AUTHOR, "d1")).toContainEqual(["image", ""]);
    expect(
      buildPrivateEventPayload(draft({ image: "https://x/y.png" }), AUTHOR, "d1"),
    ).toContainEqual(["image", "https://x/y.png"]);
  });

  it("repeats the d tag inside the payload", () => {
    // Upstream replaces the event's tags with this array and then reads the id
    // from it. Without this row every private event collapses under id "".
    expect(buildPrivateEventPayload(draft(), AUTHOR, "d1")).toContainEqual(["d", "d1"]);
  });

  it("puts the creator's p row before the participants'", () => {
    const payload = buildPrivateEventPayload(draft({ participants: [ALICE, BOB] }), AUTHOR, "d1");
    const ps = payload.filter((r) => r[0] === "p").map((r) => r[1]);
    expect(ps).toEqual([AUTHOR, ALICE, BOB]);
  });

  it("writes recurrence as an adjacent L/l label pair", () => {
    const payload = buildPrivateEventPayload(draft({ rrule: "FREQ=DAILY" }), AUTHOR, "d1");
    const labelIndex = payload.findIndex((r) => r[0] === "L");
    expect(payload[labelIndex]).toEqual(["L", "rrule"]);
    expect(payload[labelIndex + 1]).toEqual(["l", "FREQ=DAILY"]);
  });

  it("maps the friendly repeat preset when no explicit rrule is given", () => {
    const payload = buildPrivateEventPayload(
      draft({ repeat: RepeatingFrequency.Weekday }),
      AUTHOR,
      "d1",
    );
    expect(payload).toContainEqual(["l", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"]);
  });

  it("prefers an explicit rrule over the preset", () => {
    const payload = buildPrivateEventPayload(
      draft({ rrule: "FREQ=YEARLY", repeat: RepeatingFrequency.Daily }),
      AUTHOR,
      "d1",
    );
    expect(payload).toContainEqual(["l", "FREQ=YEARLY"]);
  });

  it("repeats location and form rows", () => {
    const payload = buildPrivateEventPayload(
      draft({
        location: ["Room 1", "https://meet"],
        forms: [{ naddr: "naddr1a", viewKey: "vk" }, { naddr: "naddr1b" }],
      }),
      AUTHOR,
      "d1",
    );
    expect(payload).toContainEqual(["location", "Room 1"]);
    expect(payload).toContainEqual(["location", "https://meet"]);
    expect(payload).toContainEqual(["form", "naddr1a", "vk"]);
    expect(payload).toContainEqual(["form", "naddr1b"]);
  });
});

describe("buildPublicEventTags", () => {
  it("writes only the narrow row set upstream publishes", () => {
    const tags = buildPublicEventTags(
      draft({ image: "img", location: ["Room"], participants: [ALICE] }),
      "d1",
    );
    expect(tags.map((t) => t[0])).toEqual(["title", "d", "start", "end", "image", "location", "p"]);
  });

  it("writes start and end as decimal strings", () => {
    const tags = buildPublicEventTags(draft(), "d1");
    expect(tags).toContainEqual(["start", "1800000000"]);
    expect(tags).toContainEqual(["end", "1800003600"]);
  });

  it("never writes recurrence, categories or a description tag", () => {
    // Upstream's public publisher emits none of these; the description goes in
    // content. Writing them would make our public events unlike theirs.
    const tags = buildPublicEventTags(draft({ rrule: "FREQ=DAILY" }), "d1");
    expect(tags.some((t) => t[0] === "L" || t[0] === "l")).toBe(false);
    expect(tags.some((t) => t[0] === "t")).toBe(false);
    expect(tags.some((t) => t[0] === "description")).toBe(false);
  });

  it("omits an empty image rather than writing an empty row", () => {
    expect(buildPublicEventTags(draft(), "d1").some((t) => t[0] === "image")).toBe(false);
  });
});

describe("parseCalendarEvent", () => {
  it("reads a public event, taking the description from content", () => {
    const parsed = parseCalendarEvent(
      wireEvent({
        kind: CALENDAR_KINDS.publicEvent,
        content: "Daily sync",
        tags: buildPublicEventTags(draft({ participants: [ALICE] }), "d1"),
      }),
    );
    expect(parsed.id).toBe("d1");
    expect(parsed.title).toBe("Standup");
    expect(parsed.description).toBe("Daily sync");
    expect(parsed.isPrivate).toBe(false);
    expect(parsed.begin).toBe(1_800_000_000_000);
    expect(parsed.participants).toEqual([ALICE]);
  });

  it("reads a private event from the decrypted payload, not the outer tags", () => {
    const payload = buildPrivateEventPayload(draft({ participants: [ALICE] }), AUTHOR, "d1");
    const parsed = parseCalendarEvent(
      wireEvent({ tags: [["d", "d1"]], content: "<ciphertext>" }),
      { payload, viewKey: "nsec1x" },
    );
    expect(parsed.id).toBe("d1");
    expect(parsed.description).toBe("Daily sync");
    expect(parsed.participants).toEqual([AUTHOR, ALICE]);
    expect(parsed.viewKey).toBe("nsec1x");
  });

  it("never surfaces ciphertext as the description of an undecryptable event", () => {
    const parsed = parseCalendarEvent(wireEvent({ tags: [["d", "d1"]], content: "<ciphertext>" }));
    expect(parsed.description).toBe("");
  });

  it("falls back to the name row for the title", () => {
    const parsed = parseCalendarEvent(
      wireEvent({ kind: CALENDAR_KINDS.publicEvent, tags: [["name", "Legacy title"]] }),
    );
    expect(parsed.title).toBe("Legacy title");
  });

  it("reads the wide row set upstream's parser accepts", () => {
    const parsed = parseCalendarEvent(
      wireEvent({
        kind: CALENDAR_KINDS.publicEvent,
        tags: [
          ["d", "d1"],
          ["title", "T"],
          ["description", "from a tag"],
          ["t", "work"],
          ["r", "https://ref"],
          ["g", "u4pruy"],
          ["notification", "disabled"],
          ["form", "naddr1x", "vk"],
        ],
      }),
    );
    expect(parsed.description).toBe("from a tag");
    expect(parsed.categories).toEqual(["work"]);
    expect(parsed.references).toEqual(["https://ref"]);
    expect(parsed.geohashes).toEqual(["u4pruy"]);
    expect(parsed.notificationPreference).toBe("disabled");
    expect(parsed.forms).toEqual([{ naddr: "naddr1x", viewKey: "vk" }]);
  });

  it("degrades a malformed timestamp to created_at instead of NaN", () => {
    // A NaN begin silently drops the event from every date-range query, so the
    // user simply never sees it again.
    const parsed = parseCalendarEvent(
      wireEvent({
        kind: CALENDAR_KINDS.publicEvent,
        created_at: 1_700_000_000,
        tags: [["start", "not-a-number"], ["end", ""]],
      }),
    );
    expect(parsed.begin).toBe(1_700_000_000_000);
    expect(parsed.end).toBe(1_700_000_000_000 + 3_600_000);
  });

  it("keeps a legitimate zero timestamp", () => {
    const parsed = parseCalendarEvent(
      wireEvent({ kind: CALENDAR_KINDS.publicEvent, tags: [["start", "0"], ["end", "3600"]] }),
    );
    expect(parsed.begin).toBe(0);
    expect(parsed.end).toBe(3_600_000);
  });
});

describe("readRrule", () => {
  it("takes the l row after the L label, not the first l anywhere", () => {
    expect(
      readRrule([
        ["l", "en", "ISO-639-1"],
        ["L", "rrule"],
        ["l", "FREQ=DAILY"],
      ]),
    ).toBe("FREQ=DAILY");
  });

  it("accepts the legacy self-labelled three-element form", () => {
    expect(readRrule([["l", "FREQ=WEEKLY", "rrule"]])).toBe("FREQ=WEEKLY");
  });

  it("accepts the oldest bare rrule row", () => {
    expect(readRrule([["rrule", "FREQ=MONTHLY"]])).toBe("FREQ=MONTHLY");
  });

  it("is null when there is no recurrence", () => {
    expect(readRrule([["title", "x"]])).toBeNull();
  });
});

describe("isAllDayEvent", () => {
  const midnight = (day: number) => new Date(2026, 3, day, 0, 0, 0, 0).getTime();

  it("is true for a midnight-to-midnight span of at least a day", () => {
    expect(isAllDayEvent(midnight(1), midnight(2))).toBe(true);
  });

  it("is false for a timed event", () => {
    expect(isAllDayEvent(midnight(1) + 3_600_000, midnight(1) + 7_200_000)).toBe(false);
  });

  it("is false for a zero-length or inverted span", () => {
    expect(isAllDayEvent(midnight(1), midnight(1))).toBe(false);
    expect(isAllDayEvent(midnight(2), midnight(1))).toBe(false);
  });
});
