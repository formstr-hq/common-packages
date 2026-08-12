import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { collectDeleted, isDeleted } from "./deletions";

const PUBKEY = "a".repeat(64);
const OTHER = "b".repeat(64);

function deletion(tags: string[][], pubkey = PUBKEY): Event {
  return { id: "d1", pubkey, created_at: 1, kind: 5, tags, content: "", sig: "" } as Event;
}

function board(id: string, dTag: string, pubkey = PUBKEY): Event {
  return {
    id,
    pubkey,
    created_at: 1,
    kind: 30301,
    tags: [["d", dTag]],
    content: "",
    sig: "",
  } as Event;
}

const coordinateOf = (e: Event) =>
  `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;

describe("collectDeleted", () => {
  it("collects both e and a targets", () => {
    const deleted = collectDeleted([
      deletion([
        ["e", "abc"],
        ["a", `30301:${PUBKEY}:board7`],
      ]),
    ]);
    const own = deleted.byAuthor.get(PUBKEY);
    expect(own?.ids.has("abc")).toBe(true);
    expect(own?.coordinates.has(`30301:${PUBKEY}:board7`)).toBe(true);
  });

  it("returns nothing for no deletions", () => {
    expect(collectDeleted([]).byAuthor.size).toBe(0);
  });

  it("keeps two authors' deletions apart", () => {
    const deleted = collectDeleted([
      deletion([["e", "mine"]]),
      deletion([["e", "theirs"]], OTHER),
    ]);
    expect(deleted.byAuthor.get(PUBKEY)?.ids.has("theirs")).toBe(false);
    expect(deleted.byAuthor.get(OTHER)?.ids.has("mine")).toBe(false);
  });
});

describe("isDeleted", () => {
  it("matches by event id", () => {
    const deleted = collectDeleted([deletion([["e", "abc"]])]);
    expect(isDeleted(board("abc", "board7"), deleted, coordinateOf)).toBe(true);
  });

  it("matches by coordinate", () => {
    const deleted = collectDeleted([deletion([["a", `30301:${PUBKEY}:board7`]])]);
    expect(isDeleted(board("xyz", "board7"), deleted, coordinateOf)).toBe(true);
  });

  it("leaves unrelated events alone", () => {
    const deleted = collectDeleted([deletion([["e", "other"]])]);
    expect(isDeleted(board("abc", "board7"), deleted, coordinateOf)).toBe(false);
  });

  it("ignores a deletion signed by anyone but the event's author", () => {
    const deleted = collectDeleted([
      deletion(
        [
          ["e", "abc"],
          ["a", `30301:${PUBKEY}:board7`],
        ],
        OTHER,
      ),
    ]);
    expect(isDeleted(board("abc", "board7"), deleted, coordinateOf)).toBe(false);
  });

  it("matches by id alone when the event has no coordinate", () => {
    const wrap = { id: "wrap1", pubkey: PUBKEY, kind: 1059, tags: [] } as unknown as Event;
    const deleted = collectDeleted([deletion([["e", "wrap1"]])]);
    expect(isDeleted(wrap, deleted)).toBe(true);
  });
});
