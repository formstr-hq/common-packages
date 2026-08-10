import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  boardListDTag,
  buildBoardRef,
  decodeBoardList,
  encodeBoardList,
  parseBoardRef,
} from "./boardList";
import type { BoardListRef, KanbanBoardList } from "../types";

const REF: BoardListRef = {
  coordinate: `32301:${"c".repeat(64)}:board-d`,
  relayHint: "wss://relay.example/",
  viewKey: "nsec1qqqqq",
  role: "owner",
};

const LIST: KanbanBoardList = {
  id: "list-d",
  eventId: "e".repeat(64),
  title: "Work",
  boards: [REF],
  createdAt: 1753600000,
};

describe("boardListDTag", () => {
  it("matches NIP-52E's derivation: sha256(title:createdAt) truncated to 16", () => {
    const expected = createHash("sha256")
      .update("Work:1753600000", "utf8")
      .digest("hex")
      .slice(0, 16);
    expect(boardListDTag("Work", 1753600000)).toBe(expected);
    expect(boardListDTag("Work", 1753600000)).toHaveLength(16);
  });
});

describe("buildBoardRef / parseBoardRef", () => {
  it("round-trips the five-element ref", () => {
    const tag = buildBoardRef(REF);
    expect(tag).toEqual(["a", REF.coordinate, "wss://relay.example/", "nsec1qqqqq", "owner"]);
    expect(parseBoardRef(tag)).toEqual(REF);
  });

  it("tolerates NIP-52E's three-element form and defaults the role to member", () => {
    expect(parseBoardRef(["a", REF.coordinate, "wss://relay.example/"])).toEqual({
      coordinate: REF.coordinate,
      relayHint: "wss://relay.example/",
      viewKey: "",
      role: "member",
    });
  });

  it("defaults an unrecognised role to member rather than trusting it", () => {
    const parsed = parseBoardRef(["a", REF.coordinate, "", "nsec1qqqqq", "admin"]);
    expect(parsed!.role).toBe("member");
  });

  it("rejects a tag that is not an a-ref", () => {
    expect(parseBoardRef(["title", "Work"])).toBeNull();
    expect(parseBoardRef(["a"])).toBeNull();
  });
});

describe("encodeBoardList / decodeBoardList", () => {
  it("round-trips through the NIP tags array", () => {
    const decoded = decodeBoardList(encodeBoardList(LIST), "list-d", "e".repeat(64));
    expect(decoded.title).toBe("Work");
    expect(decoded.boards).toEqual([REF]);
    expect(decoded.id).toBe("list-d");
    expect(decoded.eventId).toBe("e".repeat(64));
  });

  it("encodes title first, then one a-tag per board", () => {
    expect(encodeBoardList(LIST)).toEqual([["title", "Work"], buildBoardRef(REF)]);
  });

  it("falls back to a default title and no boards on an empty payload", () => {
    const decoded = decodeBoardList([], "list-d", "e".repeat(64));
    expect(decoded.title).toBe("My Boards");
    expect(decoded.boards).toEqual([]);
  });

  it("skips malformed rows instead of failing the whole list", () => {
    const decoded = decodeBoardList(
      [["title", "Work"], ["a"], buildBoardRef(REF), ["junk"]],
      "list-d",
      "e".repeat(64),
    );
    expect(decoded.boards).toEqual([REF]);
  });
});
