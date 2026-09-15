import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { buildPublicBoardTags, parsePublicBoard } from "../src/codec/board";
import { buildPublicCardTags, parsePublicCard } from "../src/codec/card";
import { parseBoardLikeKanbanstr, parseCardLikeKanbanstr } from "./kanbanstr-parsers";

const PUBKEY = "a".repeat(64);
const ASSIGNEE = "b".repeat(64);
const COORD = `30301:${PUBKEY}:board7`;

function asEvent(kind: number, tags: string[][], content = ""): Event {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind,
    tags,
    content,
    sig: "",
  } as Event;
}

describe("boards we write are readable by kanbanstr", () => {
  it("survives kanbanstr's board parser intact", () => {
    const tags = buildPublicBoardTags(
      {
        title: "Roadmap",
        description: "Q3",
        columns: [
          { id: "c1", name: "To Do", order: 0 },
          { id: "c2", name: "Done", order: 1 },
        ],
        participants: [ASSIGNEE],
        noZap: true,
      },
      "board7",
    );

    const theirs = parseBoardLikeKanbanstr(asEvent(30301, tags));

    expect(theirs.id).toBe("board7");
    expect(theirs.title).toBe("Roadmap");
    expect(theirs.description).toBe("Q3");
    expect(theirs.columns).toEqual([
      { id: "c1", name: "To Do", order: 0 },
      { id: "c2", name: "Done", order: 1 },
    ]);
    expect(theirs.maintainers).toEqual([ASSIGNEE]);
    expect(theirs.isNoZapBoard).toBe(true);
  });
});

describe("cards we write are readable by kanbanstr", () => {
  it("survives kanbanstr's card parser intact", () => {
    const tags = buildPublicCardTags(
      {
        title: "Ship it",
        description: "body",
        status: "To Do",
        attachments: ["https://example.com/a.png"],
        assignees: [ASSIGNEE],
        labels: ["backend"],
        links: [
          {
            boardPubkey: PUBKEY,
            boardDTag: "board9",
            cardDTag: "card9",
            forwardLabel: "is blocked by",
            reverseLabel: "blocks",
          },
        ],
      },
      "card1",
      COORD,
      15,
    );

    const theirs = parseCardLikeKanbanstr(asEvent(30302, tags));

    expect(theirs.title).toBe("Ship it");
    expect(theirs.status).toBe("To Do");
    expect(theirs.order).toBe(15);
    expect(theirs.aTags).toEqual([COORD]);
    expect(theirs.attachments).toEqual(["https://example.com/a.png"]);
    expect(theirs.tTags).toEqual(["backend"]);
    expect(theirs.iTags[0][1]).toBe(`kanban:${PUBKEY}:board9:card9`);
  });

  it("writes assignees so kanbanstr's zap routing works", () => {
    const tags = buildPublicCardTags({ title: "X", assignees: [ASSIGNEE] }, "c1", COORD, 10);
    const theirs = parseCardLikeKanbanstr(asEvent(30302, tags));
    // Their parser reads p AND zap without deduping, so both must be present.
    expect(theirs.assignees).toEqual([ASSIGNEE, ASSIGNEE]);
  });
});

describe("boards and cards kanbanstr writes are readable by us", () => {
  it("parses a kanbanstr-shaped board", () => {
    const ours = parsePublicBoard(
      asEvent(30301, [
        ["d", "board7"],
        ["title", "Roadmap"],
        ["description", "Q3"],
        ["alt", "A board titled Roadmap"],
        ["col", "c1", "To Do", "0"],
        ["p", ASSIGNEE],
        ["nozap"],
      ]),
    );

    expect(ours!.title).toBe("Roadmap");
    expect(ours!.columns).toEqual([{ id: "c1", name: "To Do", order: 0 }]);
    expect(ours!.participants).toEqual([ASSIGNEE]);
    expect(ours!.noZap).toBe(true);
  });

  it("parses a kanbanstr-shaped card, deduping the doubled assignee", () => {
    const ours = parsePublicCard(
      asEvent(30302, [
        ["d", "card1"],
        ["title", "Ship it"],
        ["s", "To Do"],
        ["rank", "15"],
        ["a", COORD],
        ["zap", ASSIGNEE],
        ["p", ASSIGNEE],
        ["binned"],
      ]),
    );

    expect(ours!.status).toBe("To Do");
    expect(ours!.rank).toBe(15);
    expect(ours!.assignees).toEqual([ASSIGNEE]);
    expect(ours!.binned).toBe(true);
  });

  it("parses a v0 legacy board", () => {
    const ours = parsePublicBoard(
      asEvent(
        30301,
        [
          ["d", "board0"],
          ["title", "Old"],
          ["a", "30302:x:card1"],
        ],
        JSON.stringify({
          description: "from content",
          columns: [{ id: "c1", name: "To Do", order: 0 }],
        }),
      ),
    );

    expect(ours!.legacy).toBe(true);
    expect(ours!.description).toBe("from content");
    expect(ours!.columns).toEqual([{ id: "c1", name: "To Do", order: 0 }]);
  });
});
