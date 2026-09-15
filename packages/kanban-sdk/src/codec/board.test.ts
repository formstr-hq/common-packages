import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import {
  BOARD_MANAGED_TAGS,
  boardCoordinate,
  buildPrivateBoardTags,
  buildPublicBoardTags,
  isLegacyBoard,
  mergeTags,
  parsePrivateBoard,
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
        participants: ["b".repeat(64)],
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

  it("emits one p tag per person, however often they were added", () => {
    const bob = "b".repeat(64);
    const tags = buildPublicBoardTags({ title: "X", columns: [], participants: [bob, bob] }, "d1");
    expect(tags.filter((t) => t[0] === "p")).toEqual([["p", bob]]);
  });

  it("p-tags an admin as well as admin-tagging them, so kanbanstr grants card writes", () => {
    const alice = "a".repeat(64);
    const tags = buildPublicBoardTags({ title: "X", columns: [], admins: [alice] }, "d1");
    expect(tags).toContainEqual(["admin", alice]);
    expect(tags).toContainEqual(["p", alice]);
  });

  it("emits baked only once the creator has folded patches down", () => {
    expect(buildPublicBoardTags({ title: "X", columns: [] }, "d1").some((t) => t[0] === "baked")).toBe(
      false,
    );
    expect(buildPublicBoardTags({ title: "X", columns: [], baked: 1700 }, "d1")).toContainEqual([
      "baked",
      "1700",
    ]);
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
    expect(board!.participants).toEqual(["b".repeat(64)]);
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

const PRIVATE_AUTHOR = "c".repeat(64);

function privateBoardEvent(dTag: string, overrides: Partial<Event> = {}): Event {
  return {
    id: "e".repeat(64),
    pubkey: PRIVATE_AUTHOR,
    created_at: 1753600000,
    kind: 32301,
    tags: [["d", dTag]],
    content: "<encrypted>",
    sig: "f".repeat(128),
    ...overrides,
  } as Event;
}

describe("buildPrivateBoardTags", () => {
  it("emits the doc 05 §3 inner tags", () => {
    const tags = buildPrivateBoardTags(
      {
        title: "Q3 Roadmap",
        description: "Markdown allowed",
        columns: [
          { id: "col-1", name: "To Do", order: 0 },
          { id: "col-2", name: "Done", order: 1 },
        ],
        admins: ["a".repeat(64)],
        participants: ["b".repeat(64)],
        noZap: true,
      },
      "board-d",
    );

    expect(tags).toEqual([
      ["d", "board-d"],
      ["title", "Q3 Roadmap"],
      ["description", "Markdown allowed"],
      ["col", "col-1", "To Do", "0"],
      ["col", "col-2", "Done", "1"],
      ["admin", "a".repeat(64)],
      ["maintainer", "a".repeat(64)],
      ["maintainer", "b".repeat(64)],
      ["nozap"],
    ]);
  });

  it("emits one row per pubkey, and never two conflicting roles for one", () => {
    const alice = "a".repeat(64);
    const bob = "b".repeat(64);
    const tags = buildPrivateBoardTags(
      { title: "X", columns: [], admins: [alice, alice], participants: [alice, bob, bob] },
      "d1",
    );

    expect(tags.filter((t) => t[0] === "admin")).toEqual([["admin", alice]]);
    expect(tags.filter((t) => t[0] === "maintainer")).toEqual([
      ["maintainer", alice],
      ["maintainer", bob],
    ]);
  });

  it("re-emits legacy viewers so an edit does not erase who still holds a key", () => {
    const carol = "c".repeat(64);
    const tags = buildPrivateBoardTags({ title: "X", columns: [], legacyViewers: [carol] }, "d1");
    expect(tags).toContainEqual(["member", carol]);
  });

  it("never emits an alt tag — NIP-31 would restate the title in plaintext", () => {
    const tags = buildPrivateBoardTags({ title: "Secret", columns: [] }, "d1");
    expect(tags.some((t) => t[0] === "alt")).toBe(false);
  });

  it("uses maintainer/member, never p — p would leak membership and collides with assignee", () => {
    const tags = buildPrivateBoardTags(
      { title: "T", columns: [], participants: ["a".repeat(64)] },
      "d1",
    );
    expect(tags.some((t) => t[0] === "p")).toBe(false);
  });
});

describe("parsePrivateBoard", () => {
  it("reads the decrypted inner tags and keeps them as rawTags for merging", () => {
    const inner = buildPrivateBoardTags(
      {
        title: "Q3 Roadmap",
        description: "d",
        columns: [{ id: "col-1", name: "To Do", order: 0 }],
        admins: ["a".repeat(64)],
        participants: ["b".repeat(64)],
      },
      "board-d",
    );
    const board = parsePrivateBoard(privateBoardEvent("board-d"), inner);

    expect(board).not.toBeNull();
    expect(board!.title).toBe("Q3 Roadmap");
    expect(board!.isPrivate).toBe(true);
    expect(board!.legacy).toBe(false);
    expect(board!.admins).toEqual(["a".repeat(64)]);
    expect(board!.participants).toEqual(["b".repeat(64)]);
    expect(board!.rawTags).toBe(inner);
  });

  it("sorts columns by order", () => {
    const inner: string[][] = [
      ["d", "board-d"],
      ["title", "T"],
      ["col", "c2", "Second", "1"],
      ["col", "c1", "First", "0"],
    ];
    const board = parsePrivateBoard(privateBoardEvent("board-d"), inner);
    expect(board!.columns.map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("rejects a payload whose inner d does not match the outer d", () => {
    const inner = buildPrivateBoardTags({ title: "T", columns: [] }, "other-board");
    expect(parsePrivateBoard(privateBoardEvent("board-d"), inner)).toBeNull();
  });

  it("rejects a payload with no inner d", () => {
    expect(parsePrivateBoard(privateBoardEvent("board-d"), [["title", "T"]])).toBeNull();
  });
});

describe("boardCoordinate", () => {
  it("uses 30301 for public boards and 32301 for private ones", () => {
    expect(boardCoordinate({ pubkey: PRIVATE_AUTHOR, id: "x" })).toBe(`30301:${PRIVATE_AUTHOR}:x`);
    expect(boardCoordinate({ pubkey: PRIVATE_AUTHOR, id: "x", isPrivate: true })).toBe(
      `32301:${PRIVATE_AUTHOR}:x`,
    );
  });
});

describe("role parsing", () => {
  const ALICE = "a".repeat(64);
  const BOB = "b".repeat(64);
  const CAROL = "c".repeat(64);

  it("splits a public board's p tags into admins and participants", () => {
    const board = parsePublicBoard(
      boardEvent([
        ["d", "b1"],
        ["admin", ALICE],
        ["p", ALICE],
        ["p", BOB],
      ]),
    );

    expect(board!.admins).toEqual([ALICE]);
    // Never both: an admin listed as a participant too would show up twice in
    // any roster built by concatenating the two.
    expect(board!.participants).toEqual([BOB]);
  });

  it("splits a private board's maintainer tags the same way", () => {
    const board = parsePrivateBoard(boardEvent([["d", "b1"]]), [
      ["d", "b1"],
      ["admin", ALICE],
      ["maintainer", ALICE],
      ["maintainer", BOB],
    ]);

    expect(board!.admins).toEqual([ALICE]);
    expect(board!.participants).toEqual([BOB]);
  });

  it("treats an admin tag with no matching p tag as an admin regardless", () => {
    const board = parsePublicBoard(boardEvent([["d", "b1"], ["admin", ALICE]]));
    expect(board!.admins).toEqual([ALICE]);
  });

  it("keeps member tags as legacy viewers, out of both live roles", () => {
    const board = parsePrivateBoard(boardEvent([["d", "b1"]]), [
      ["d", "b1"],
      ["maintainer", BOB],
      ["member", CAROL],
    ]);

    expect(board!.legacyViewers).toEqual([CAROL]);
    expect(board!.participants).toEqual([BOB]);
    expect(board!.admins).toEqual([]);
  });

  it("has no legacy viewers on a public board, which never had the role", () => {
    expect(parsePublicBoard(boardEvent([["d", "b1"]]))!.legacyViewers).toEqual([]);
  });

  it("reads the baked watermark, defaulting to zero", () => {
    expect(parsePublicBoard(boardEvent([["d", "b1"]]))!.baked).toBe(0);
    expect(parsePublicBoard(boardEvent([["d", "b1"], ["baked", "1700"]]))!.baked).toBe(1700);
  });

  it("treats an unparseable baked value as never baked", () => {
    expect(parsePublicBoard(boardEvent([["d", "b1"], ["baked", "soon"]]))!.baked).toBe(0);
  });
});
