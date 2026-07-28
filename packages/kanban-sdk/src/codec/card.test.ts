import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import {
  buildCardLinkTag,
  buildPublicCardTags,
  parseCardLink,
  parsePublicCard,
  buildPrivateCardTags,
  parsePrivateCard,
} from "./card";

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

const BOARD_COORDINATE = `32301:${"c".repeat(64)}:board-d`;

function privateCardEvent(dTag: string, pointer = "b".repeat(64)): Event {
  return {
    id: "e".repeat(64),
    pubkey: "c".repeat(64),
    created_at: 1753600100,
    kind: 32302,
    tags: [
      ["d", dTag],
      ["b", pointer],
    ],
    content: "<encrypted>",
    sig: "f".repeat(128),
  } as Event;
}

describe("buildPrivateCardTags", () => {
  it("emits the doc 05 §4 inner tags with a inside the payload", () => {
    const tags = buildPrivateCardTags(
      {
        title: "Ship the SDK",
        description: "body",
        status: "col-2",
        attachments: ["https://blossom.example/abc.png"],
        assignees: ["a".repeat(64)],
        labels: ["backend"],
      },
      "card-d",
      BOARD_COORDINATE,
      10,
    );

    expect(tags).toEqual([
      ["d", "card-d"],
      ["a", BOARD_COORDINATE],
      ["title", "Ship the SDK"],
      ["description", "body"],
      ["rank", "10"],
      ["s", "col-2"],
      ["u", "https://blossom.example/abc.png"],
      ["t", "backend"],
      ["p", "a".repeat(64)],
    ]);
  });

  it("omits s when the card is unmapped", () => {
    const tags = buildPrivateCardTags({ title: "T" }, "card-d", BOARD_COORDINATE, 10);
    expect(tags.some((t) => t[0] === "s")).toBe(false);
  });

  it("writes assignees once — the kanbanstr zap-tag duplication is public-interop only", () => {
    const tags = buildPrivateCardTags(
      { title: "T", assignees: ["a".repeat(64)] },
      "card-d",
      BOARD_COORDINATE,
      10,
    );
    expect(tags.filter((t) => t[0] === "zap")).toHaveLength(0);
    expect(tags.filter((t) => t[0] === "p")).toHaveLength(1);
  });

  it("never emits an alt tag", () => {
    const tags = buildPrivateCardTags({ title: "Secret" }, "card-d", BOARD_COORDINATE, 10);
    expect(tags.some((t) => t[0] === "alt")).toBe(false);
  });

  it("round-trips card links", () => {
    const link = {
      boardPubkey: "a".repeat(64),
      boardDTag: "board-2",
      cardDTag: "card-9",
      forwardLabel: "is blocked by",
      reverseLabel: "blocks",
    };
    const tags = buildPrivateCardTags({ title: "T", links: [link] }, "d", BOARD_COORDINATE, 10);
    const card = parsePrivateCard(privateCardEvent("d"), tags);
    expect(card!.links).toEqual([link]);
  });
});

describe("parsePrivateCard", () => {
  it("reads inner tags and keeps them as rawTags", () => {
    const inner = buildPrivateCardTags(
      { title: "Ship the SDK", status: "col-2" },
      "card-d",
      BOARD_COORDINATE,
      10,
    );
    const card = parsePrivateCard(privateCardEvent("card-d"), inner);

    expect(card).not.toBeNull();
    expect(card!.title).toBe("Ship the SDK");
    expect(card!.status).toBe("col-2");
    expect(card!.rank).toBe(10);
    expect(card!.boardCoordinate).toBe(BOARD_COORDINATE);
    expect(card!.isPrivate).toBe(true);
    expect(card!.rawTags).toBe(inner);
  });

  it("rejects a payload whose inner d does not match the outer d", () => {
    const inner = buildPrivateCardTags({ title: "T" }, "other-card", BOARD_COORDINATE, 10);
    expect(parsePrivateCard(privateCardEvent("card-d"), inner)).toBeNull();
  });

  it("rejects a payload with no a tag — the board association is not optional", () => {
    const inner: string[][] = [
      ["d", "card-d"],
      ["title", "T"],
    ];
    expect(parsePrivateCard(privateCardEvent("card-d"), inner)).toBeNull();
  });

  it("preserves tracker tags a newer client wrote", () => {
    const inner: string[][] = [
      ["d", "card-d"],
      ["a", BOARD_COORDINATE],
      ["title", "Tracker"],
      ["k", "1621"],
      ["e", "f".repeat(64)],
    ];
    const card = parsePrivateCard(privateCardEvent("card-d"), inner);
    expect(card!.trackedKind).toBe(1621);
    expect(card!.trackedRef).toEqual({ eventId: "f".repeat(64) });
  });
});
