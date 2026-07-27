import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { collectDeleted, isDeleted } from "./deletions";

const PUBKEY = "a".repeat(64);

function deletion(tags: string[][]): Event {
  return { id: "d1", pubkey: PUBKEY, created_at: 1, kind: 5, tags, content: "", sig: "" } as Event;
}

function board(id: string, dTag: string): Event {
  return {
    id,
    pubkey: PUBKEY,
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
    expect(deleted.ids.has("abc")).toBe(true);
    expect(deleted.coordinates.has(`30301:${PUBKEY}:board7`)).toBe(true);
  });

  it("returns empty sets for no deletions", () => {
    const deleted = collectDeleted([]);
    expect(deleted.ids.size).toBe(0);
    expect(deleted.coordinates.size).toBe(0);
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
});
