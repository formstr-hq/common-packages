import type { Event } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { buildCommentTags, parseComment } from "./comment";

const BOARD_COORDINATE = `32301:${"c".repeat(64)}:board-d`;

function commentEvent(dTag: string): Event {
  return {
    id: "e".repeat(64),
    pubkey: "c".repeat(64),
    created_at: 1753600200,
    kind: 32304,
    tags: [
      ["d", dTag],
      ["b", "b".repeat(64)],
    ],
    content: "<encrypted>",
    sig: "f".repeat(128),
  } as Event;
}

describe("buildCommentTags", () => {
  it("emits the doc 05 §5b inner tags", () => {
    expect(
      buildCommentTags(
        { content: "Looks good, shipping Friday", mentions: ["a".repeat(64)], replyTo: "c-1" },
        "comment-d",
        BOARD_COORDINATE,
        "card-d",
      ),
    ).toEqual([
      ["d", "comment-d"],
      ["a", BOARD_COORDINATE],
      ["e", "card-d"],
      ["content", "Looks good, shipping Friday"],
      ["p", "a".repeat(64)],
      ["reply", "c-1"],
    ]);
  });

  it("references the card by its d identifier, not an event id", () => {
    // A card's event id changes on every edit; its `d` does not.
    const tags = buildCommentTags({ content: "x" }, "comment-d", BOARD_COORDINATE, "card-d");
    expect(tags.find((t) => t[0] === "e")![1]).toBe("card-d");
  });

  it("omits reply when the comment is top-level", () => {
    const tags = buildCommentTags({ content: "x" }, "comment-d", BOARD_COORDINATE, "card-d");
    expect(tags.some((t) => t[0] === "reply")).toBe(false);
  });
});

describe("parseComment", () => {
  it("reads the inner tags and keeps them as rawTags", () => {
    const inner = buildCommentTags(
      { content: "hello", mentions: ["a".repeat(64)] },
      "comment-d",
      BOARD_COORDINATE,
      "card-d",
    );
    const comment = parseComment(commentEvent("comment-d"), inner);

    expect(comment).not.toBeNull();
    expect(comment!.content).toBe("hello");
    expect(comment!.cardId).toBe("card-d");
    expect(comment!.boardCoordinate).toBe(BOARD_COORDINATE);
    expect(comment!.mentions).toEqual(["a".repeat(64)]);
    expect(comment!.replyTo).toBeUndefined();
    expect(comment!.rawTags).toBe(inner);
  });

  it("carries rotation attribution exactly as a card does", () => {
    const inner: string[][] = [
      ["d", "comment-d"],
      ["a", BOARD_COORDINATE],
      ["e", "card-d"],
      ["content", "written by Bob, rotated by Alice"],
      ["rotated-author", "b".repeat(64)],
    ];
    const comment = parseComment(commentEvent("comment-d"), inner);

    expect(comment!.pubkey).toBe("c".repeat(64));
    expect(comment!.authorPubkey).toBe("b".repeat(64));
    expect(comment!.rotated).toBe(true);
  });

  it("rejects a payload whose inner d does not match the outer d", () => {
    const inner = buildCommentTags({ content: "x" }, "other", BOARD_COORDINATE, "card-d");
    expect(parseComment(commentEvent("comment-d"), inner)).toBeNull();
  });

  it("rejects a payload with no a tag", () => {
    expect(
      parseComment(commentEvent("comment-d"), [
        ["d", "comment-d"],
        ["e", "card-d"],
        ["content", "x"],
      ]),
    ).toBeNull();
  });

  it("rejects a payload with no card reference", () => {
    expect(
      parseComment(commentEvent("comment-d"), [
        ["d", "comment-d"],
        ["a", BOARD_COORDINATE],
        ["content", "x"],
      ]),
    ).toBeNull();
  });
});
