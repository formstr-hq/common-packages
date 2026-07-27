import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import {
  BOARD_MANAGED_TAGS,
  boardCoordinate,
  buildPublicBoardTags,
  isLegacyBoard,
  mergeTags,
  parsePublicBoard,
} from "./board";

const PUBKEY = "a".repeat(64);

function boardEvent(tags: string[][], content = ""): Event {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: 30301,
    tags,
    content,
    sig: "",
  } as Event;
}

describe("buildPublicBoardTags", () => {
  it("emits d, title, description, alt, col and p tags", () => {
    const tags = buildPublicBoardTags(
      {
        title: "Roadmap",
        description: "Q3 work",
        columns: [
          { id: "c1", name: "To Do", order: 0 },
          { id: "c2", name: "Done", order: 1 },
        ],
        maintainers: ["b".repeat(64)],
      },
      "board7",
    );

    expect(tags).toContainEqual(["d", "board7"]);
    expect(tags).toContainEqual(["title", "Roadmap"]);
    expect(tags).toContainEqual(["description", "Q3 work"]);
    expect(tags).toContainEqual(["alt", "A board titled Roadmap"]);
    expect(tags).toContainEqual(["col", "c1", "To Do", "0"]);
    expect(tags).toContainEqual(["col", "c2", "Done", "1"]);
    expect(tags).toContainEqual(["p", "b".repeat(64)]);
  });

  it("emits nozap only when requested", () => {
    const without = buildPublicBoardTags({ title: "X", columns: [] }, "d1");
    expect(without.some((t) => t[0] === "nozap")).toBe(false);

    const with_ = buildPublicBoardTags({ title: "X", columns: [], noZap: true }, "d1");
    expect(with_).toContainEqual(["nozap"]);
  });
});

describe("parsePublicBoard", () => {
  it("reads a well-formed board", () => {
    const board = parsePublicBoard(
      boardEvent([
        ["d", "board7"],
        ["title", "Roadmap"],
        ["description", "Q3 work"],
        ["col", "c1", "To Do", "0"],
        ["col", "c2", "Done", "1"],
        ["p", "b".repeat(64)],
      ]),
    );

    expect(board).not.toBeNull();
    expect(board!.id).toBe("board7");
    expect(board!.title).toBe("Roadmap");
    expect(board!.columns).toEqual([
      { id: "c1", name: "To Do", order: 0 },
      { id: "c2", name: "Done", order: 1 },
    ]);
    expect(board!.maintainers).toEqual(["b".repeat(64)]);
    expect(board!.noZap).toBe(false);
    expect(board!.legacy).toBe(false);
    expect(board!.isPrivate).toBe(false);
  });

  it("sorts columns by order regardless of tag sequence", () => {
    const board = parsePublicBoard(
      boardEvent([
        ["d", "b1"],
        ["title", "X"],
        ["col", "c2", "Done", "1"],
        ["col", "c1", "To Do", "0"],
      ]),
    );
    expect(board!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("returns null when the d tag is missing", () => {
    expect(parsePublicBoard(boardEvent([["title", "X"]]))).toBeNull();
  });

  it("falls back to a placeholder title", () => {
    const board = parsePublicBoard(boardEvent([["d", "b1"]]));
    expect(board!.title).toBe("Untitled Board");
  });

  it("reads the nozap flag", () => {
    const board = parsePublicBoard(boardEvent([["d", "b1"], ["title", "X"], ["nozap"]]));
    expect(board!.noZap).toBe(true);
  });

  it("retains rawTags so edits can merge", () => {
    const event = boardEvent([["d", "b1"], ["title", "X"], ["unknown", "keep me"]]);
    expect(parsePublicBoard(event)!.rawTags).toContainEqual(["unknown", "keep me"]);
  });
});

describe("isLegacyBoard", () => {
  it("detects v0 boards that list cards with a tags", () => {
    expect(isLegacyBoard(boardEvent([["d", "b1"], ["a", "30302:x:card1"]]))).toBe(true);
  });

  it("detects v0 boards that keep columns in JSON content", () => {
    const event = boardEvent([["d", "b1"]], JSON.stringify({ columns: [], description: "old" }));
    expect(isLegacyBoard(event)).toBe(true);
  });

  it("is false for current-format boards", () => {
    expect(isLegacyBoard(boardEvent([["d", "b1"], ["col", "c1", "To Do", "0"]]))).toBe(false);
  });

  it("does not throw on non-JSON content", () => {
    expect(isLegacyBoard(boardEvent([["d", "b1"]], "not json"))).toBe(false);
  });
});

describe("mergeTags", () => {
  it("replaces managed tags and preserves unknown ones", () => {
    const merged = mergeTags(
      [["d", "b1"], ["title", "Old"], ["nozap"], ["weird", "keep"]],
      [["d", "b1"], ["title", "New"]],
      BOARD_MANAGED_TAGS,
    );

    expect(merged).toContainEqual(["title", "New"]);
    expect(merged).not.toContainEqual(["title", "Old"]);
    expect(merged).toContainEqual(["weird", "keep"]);
  });

  it("drops a managed tag that the new set omits", () => {
    const merged = mergeTags([["d", "b1"], ["nozap"]], [["d", "b1"]], BOARD_MANAGED_TAGS);
    expect(merged.some((t) => t[0] === "nozap")).toBe(false);
  });
});

describe("boardCoordinate", () => {
  it("builds a NIP-01 address", () => {
    expect(boardCoordinate({ pubkey: PUBKEY, id: "board7" })).toBe(`30301:${PUBKEY}:board7`);
  });
});
