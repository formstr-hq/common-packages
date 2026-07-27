import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { buildCardLinkTag, buildPublicCardTags, parseCardLink, parsePublicCard } from "./card";

const PUBKEY = "a".repeat(64);
const BOARD_PUBKEY = "b".repeat(64);
const COORD = `30301:${BOARD_PUBKEY}:board7`;

function cardEvent(tags: string[][]): Event {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: 30302,
    tags,
    content: "",
    sig: "",
  } as Event;
}

describe("buildPublicCardTags", () => {
  it("emits the core card tags", () => {
    const tags = buildPublicCardTags(
      { title: "Ship it", description: "body", status: "To Do" },
      "card1",
      COORD,
      15,
    );

    expect(tags).toContainEqual(["d", "card1"]);
    expect(tags).toContainEqual(["title", "Ship it"]);
    expect(tags).toContainEqual(["description", "body"]);
    expect(tags).toContainEqual(["alt", "A card titled Ship it"]);
    expect(tags).toContainEqual(["s", "To Do"]);
    expect(tags).toContainEqual(["rank", "15"]);
    expect(tags).toContainEqual(["a", COORD]);
  });

  it("writes each assignee as BOTH p and zap, matching kanbanstr", () => {
    const tags = buildPublicCardTags({ title: "X", assignees: [PUBKEY] }, "c1", COORD, 10);
    expect(tags).toContainEqual(["p", PUBKEY]);
    expect(tags).toContainEqual(["zap", PUBKEY]);
  });

  it("omits the s tag when there is no status", () => {
    const tags = buildPublicCardTags({ title: "X" }, "c1", COORD, 10);
    expect(tags.some((t) => t[0] === "s")).toBe(false);
  });

  it("emits attachments, labels and links", () => {
    const tags = buildPublicCardTags(
      {
        title: "X",
        attachments: ["https://example.com/a.png"],
        labels: ["backend"],
        links: [
          {
            boardPubkey: BOARD_PUBKEY,
            boardDTag: "board9",
            cardDTag: "card9",
            forwardLabel: "is blocked by",
            reverseLabel: "blocks",
          },
        ],
      },
      "c1",
      COORD,
      10,
    );

    expect(tags).toContainEqual(["u", "https://example.com/a.png"]);
    expect(tags).toContainEqual(["t", "backend"]);
    expect(tags).toContainEqual([
      "i",
      `kanban:${BOARD_PUBKEY}:board9:card9`,
      "is blocked by",
      "blocks",
    ]);
  });
});

describe("parsePublicCard", () => {
  it("reads a well-formed card", () => {
    const card = parsePublicCard(
      cardEvent([
        ["d", "card1"],
        ["title", "Ship it"],
        ["description", "body"],
        ["s", "To Do"],
        ["rank", "15"],
        ["a", COORD],
        ["u", "https://example.com/a.png"],
        ["t", "backend"],
      ]),
    );

    expect(card).not.toBeNull();
    expect(card!.id).toBe("card1");
    expect(card!.title).toBe("Ship it");
    expect(card!.status).toBe("To Do");
    expect(card!.rank).toBe(15);
    expect(card!.boardCoordinate).toBe(COORD);
    expect(card!.attachments).toEqual(["https://example.com/a.png"]);
    expect(card!.labels).toEqual(["backend"]);
    expect(card!.binned).toBe(false);
  });

  it("deduplicates assignees written as both p and zap", () => {
    const card = parsePublicCard(
      cardEvent([["d", "c1"], ["a", COORD], ["p", PUBKEY], ["zap", PUBKEY]]),
    );
    expect(card!.assignees).toEqual([PUBKEY]);
  });

  it("reads an assignee written only as zap", () => {
    const card = parsePublicCard(cardEvent([["d", "c1"], ["a", COORD], ["zap", PUBKEY]]));
    expect(card!.assignees).toEqual([PUBKEY]);
  });

  it("reads the binned flag", () => {
    const card = parsePublicCard(cardEvent([["d", "c1"], ["a", COORD], ["binned"]]));
    expect(card!.binned).toBe(true);
  });

  it("defaults rank to 0 when absent or unparseable", () => {
    expect(parsePublicCard(cardEvent([["d", "c1"], ["a", COORD]]))!.rank).toBe(0);
    expect(parsePublicCard(cardEvent([["d", "c1"], ["a", COORD], ["rank", "x"]]))!.rank).toBe(0);
  });

  it("returns null without a d tag", () => {
    expect(parsePublicCard(cardEvent([["a", COORD]]))).toBeNull();
  });

  it("captures tracker references", () => {
    const card = parsePublicCard(
      cardEvent([["d", "c1"], ["a", COORD], ["k", "1621"], ["e", "f".repeat(64), "wss://r"]]),
    );
    expect(card!.trackedKind).toBe(1621);
    expect(card!.trackedRef).toEqual({ eventId: "f".repeat(64) });
  });

  it("captures kanban-card tracker references", () => {
    const card = parsePublicCard(
      cardEvent([
        ["d", "c1"],
        ["a", COORD],
        ["k", "30302"],
        ["refs/board", `30301:${BOARD_PUBKEY}:board9`],
        ["refs/card", "card9"],
      ]),
    );
    expect(card!.trackedKind).toBe(30302);
    expect(card!.trackedRef).toEqual({
      boardCoordinate: `30301:${BOARD_PUBKEY}:board9`,
      cardDTag: "card9",
    });
  });
});

describe("card links", () => {
  it("round-trips a link through build and parse", () => {
    const link = {
      boardPubkey: BOARD_PUBKEY,
      boardDTag: "board9",
      cardDTag: "card9",
      forwardLabel: "is a child of",
      reverseLabel: "is a parent of",
    };
    expect(parseCardLink(buildCardLinkTag(link))).toEqual(link);
  });

  it("ignores i tags that are not kanban links", () => {
    expect(parseCardLink(["i", "podcast:guid:abc"])).toBeNull();
  });

  it("ignores malformed kanban links", () => {
    expect(parseCardLink(["i", "kanban:only:two"])).toBeNull();
  });

  it("defaults missing labels to empty strings", () => {
    const parsed = parseCardLink(["i", `kanban:${BOARD_PUBKEY}:board9:card9`]);
    expect(parsed!.forwardLabel).toBe("");
    expect(parsed!.reverseLabel).toBe("");
  });
});
