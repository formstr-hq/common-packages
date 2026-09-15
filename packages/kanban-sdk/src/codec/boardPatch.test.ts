import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { buildPatchTags, parsePatch } from "./boardPatch";

const ADMIN = "a".repeat(64);
const ALICE = "b".repeat(64);
const BOB = "c".repeat(64);
const BOARD_REF = `${"d".repeat(64)}:board7`;

function patchEvent(tags: string[][], content = ""): Event {
  return {
    id: "e".repeat(64),
    pubkey: ADMIN,
    created_at: 1700000000,
    kind: 30303,
    tags,
    content,
    sig: "",
  } as Event;
}

describe("buildPatchTags", () => {
  it("names the board it patches", () => {
    expect(buildPatchTags({}, BOARD_REF)).toContainEqual(["d", BOARD_REF]);
  });

  it("emits every column as a col triple", () => {
    const tags = buildPatchTags(
      { columns: [{ id: "c1", name: "Blocked", order: 3 }] },
      BOARD_REF,
    );
    expect(tags).toContainEqual(["col", "c1", "Blocked", "3"]);
  });

  it("emits removals as their own rows", () => {
    const tags = buildPatchTags(
      { columnsRemoved: ["c9"], participantsRemoved: [BOB] },
      BOARD_REF,
    );
    expect(tags).toContainEqual(["col-removed", "c9"]);
    expect(tags).toContainEqual(["maintainer-removed", BOB]);
  });

  it("omits title and description when the patch does not touch them", () => {
    const tags = buildPatchTags({ columns: [] }, BOARD_REF);
    expect(tags.some((t) => t[0] === "title")).toBe(false);
    expect(tags.some((t) => t[0] === "description")).toBe(false);
  });

  it("keeps an empty description, which clears it rather than leaving it alone", () => {
    expect(buildPatchTags({ description: "" }, BOARD_REF)).toContainEqual(["description", ""]);
  });

  it("de-duplicates participants", () => {
    const tags = buildPatchTags({ participantsAdded: [ALICE, ALICE] }, BOARD_REF);
    expect(tags.filter((t) => t[0] === "maintainer")).toEqual([["maintainer", ALICE]]);
  });
});

describe("parsePatch", () => {
  it("reads a public patch off the event's own tags", () => {
    const patch = parsePatch(
      patchEvent([
        ["d", BOARD_REF],
        ["title", "Q3 Roadmap"],
        ["col", "c1", "Blocked", "3"],
        ["col-removed", "c9"],
        ["maintainer", ALICE],
        ["maintainer-removed", BOB],
      ]),
    );

    expect(patch).toMatchObject({
      author: ADMIN,
      boardRef: BOARD_REF,
      createdAt: 1700000000,
      title: "Q3 Roadmap",
      columns: [{ id: "c1", name: "Blocked", order: 3 }],
      columnsRemoved: ["c9"],
      participantsAdded: [ALICE],
      participantsRemoved: [BOB],
    });
  });

  it("reads a private patch off the decrypted payload, not the wrapper", () => {
    const patch = parsePatch(patchEvent([["d", "pointer-1"]]), [
      ["d", "pointer-1"],
      ["title", "Secret"],
    ]);
    expect(patch?.title).toBe("Secret");
    expect(patch?.boardRef).toBe("pointer-1");
  });

  it("discards a private patch whose payload names a different board", () => {
    expect(parsePatch(patchEvent([["d", "pointer-1"]]), [["d", "pointer-2"]])).toBeNull();
  });

  it("discards a patch with no board reference", () => {
    expect(parsePatch(patchEvent([["title", "orphan"]]))).toBeNull();
  });

  it("leaves title undefined when the patch carries no title row", () => {
    expect(parsePatch(patchEvent([["d", BOARD_REF]]))?.title).toBeUndefined();
  });

  it("never reads an admin row, so a patch cannot grant admin", () => {
    const patch = parsePatch(patchEvent([["d", BOARD_REF], ["admin", BOB]]));
    expect(JSON.stringify(patch)).not.toContain(BOB);
  });

  it("skips a col row missing its id", () => {
    const patch = parsePatch(patchEvent([["d", BOARD_REF], ["col"], ["col", "c1", "Ok", "0"]]));
    expect(patch?.columns).toEqual([{ id: "c1", name: "Ok", order: 0 }]);
  });

  it("defaults a col row's order to zero when it is unparseable", () => {
    const patch = parsePatch(patchEvent([["d", BOARD_REF], ["col", "c1", "Ok", "later"]]));
    expect(patch?.columns).toEqual([{ id: "c1", name: "Ok", order: 0 }]);
  });
});
