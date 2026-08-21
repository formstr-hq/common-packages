import { describe, expect, it } from "vitest";

import type { BoardPatch } from "../codec/boardPatch";
import type { KanbanBoard } from "../types";

import { foldPatches, mergePatch, publicBoardRef } from "./boardPatches";

const CREATOR = "a".repeat(64);
const ADMIN = "b".repeat(64);
const ADMIN2 = "c".repeat(64);
const WORKER = "d".repeat(64);
const OUTSIDER = "e".repeat(64);

const REF = `${CREATOR}:board-1`;

function board(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: "board-1",
    pubkey: CREATOR,
    eventId: "evt",
    title: "Roadmap",
    description: "the plan",
    columns: [
      { id: "todo", name: "To Do", order: 0 },
      { id: "done", name: "Done", order: 1 },
    ],
    admins: [ADMIN],
    participants: [WORKER],
    legacyViewers: [],
    baked: 0,
    noZap: false,
    createdAt: 100,
    isPrivate: false,
    legacy: false,
    rawTags: [],
    ...overrides,
  };
}

function patch(overrides: Partial<BoardPatch> = {}): BoardPatch {
  return {
    author: ADMIN,
    boardRef: REF,
    createdAt: 200,
    columns: [],
    columnsRemoved: [],
    participantsAdded: [],
    participantsRemoved: [],
    ...overrides,
  };
}

describe("publicBoardRef", () => {
  it("is the creator's pubkey and the board's d tag", () => {
    expect(publicBoardRef(board())).toBe(REF);
  });
});

describe("foldPatches", () => {
  it("leaves a board with no patches exactly as it was", () => {
    const base = board();
    expect(foldPatches(base, [], REF)).toEqual(base);
  });

  it("adds a column an admin created", () => {
    const folded = foldPatches(
      board(),
      [patch({ columns: [{ id: "blocked", name: "Blocked", order: 2 }] })],
      REF,
    );
    expect(folded.columns.map((c) => c.id)).toEqual(["todo", "done", "blocked"]);
  });

  it("renames a base column in place rather than duplicating it", () => {
    const folded = foldPatches(
      board(),
      [patch({ columns: [{ id: "todo", name: "Backlog", order: 0 }] })],
      REF,
    );
    expect(folded.columns).toEqual([
      { id: "todo", name: "Backlog", order: 0 },
      { id: "done", name: "Done", order: 1 },
    ]);
  });

  it("removes a column the admin deleted", () => {
    const folded = foldPatches(board(), [patch({ columnsRemoved: ["done"] })], REF);
    expect(folded.columns.map((c) => c.id)).toEqual(["todo"]);
  });

  it("takes the newer title when two admins disagree", () => {
    const folded = foldPatches(
      board({ admins: [ADMIN, ADMIN2] }),
      [
        patch({ author: ADMIN2, createdAt: 300, title: "Later" }),
        patch({ author: ADMIN, createdAt: 200, title: "Earlier" }),
      ],
      REF,
    );
    expect(folded.title).toBe("Later");
  });

  it("clears a description a patch sets to empty", () => {
    expect(foldPatches(board(), [patch({ description: "" })], REF).description).toBe("");
  });

  it("adds and removes participants", () => {
    const folded = foldPatches(
      board(),
      [patch({ participantsAdded: [OUTSIDER], participantsRemoved: [WORKER] })],
      REF,
    );
    expect(folded.participants).toEqual([OUTSIDER]);
  });

  it("folds two admins' columns to the same result whatever order they arrive in", () => {
    const base = board({ admins: [ADMIN, ADMIN2] });
    const a = patch({ author: ADMIN, createdAt: 200, columns: [{ id: "x", name: "X", order: 2 }] });
    const b = patch({ author: ADMIN2, createdAt: 300, columns: [{ id: "y", name: "Y", order: 2 }] });

    expect(foldPatches(base, [a, b], REF)).toEqual(foldPatches(base, [b, a], REF));
  });

  describe("guards", () => {
    it("ignores a patch from somebody the board does not list as an admin", () => {
      const folded = foldPatches(board(), [patch({ author: OUTSIDER, title: "Hijacked" })], REF);
      expect(folded.title).toBe("Roadmap");
    });

    it("ignores a patch from a participant, who has card access but not board access", () => {
      const folded = foldPatches(board(), [patch({ author: WORKER, title: "Hijacked" })], REF);
      expect(folded.title).toBe("Roadmap");
    });

    it("goes inert the moment the creator demotes its author", () => {
      const live = foldPatches(board(), [patch({ title: "Renamed" })], REF);
      expect(live.title).toBe("Renamed");

      const demoted = foldPatches(board({ admins: [] }), [patch({ title: "Renamed" })], REF);
      expect(demoted.title).toBe("Roadmap");
    });

    it("never lets a patch remove the creator", () => {
      const folded = foldPatches(
        board({ participants: [CREATOR, WORKER] }),
        [patch({ participantsRemoved: [CREATOR] })],
        REF,
      );
      expect(folded.participants).toContain(CREATOR);
    });

    it("never lets one admin remove another", () => {
      const folded = foldPatches(
        board({ admins: [ADMIN, ADMIN2], participants: [ADMIN2] }),
        [patch({ participantsRemoved: [ADMIN2] })],
        REF,
      );
      expect(folded.participants).toContain(ADMIN2);
    });

    it("never lets a patch add an admin", () => {
      const folded = foldPatches(board(), [patch({ participantsAdded: [OUTSIDER] })], REF);
      expect(folded.admins).toEqual([ADMIN]);
      expect(folded.participants).toContain(OUTSIDER);
    });

    it("ignores a patch aimed at a different board", () => {
      const folded = foldPatches(board(), [patch({ boardRef: "other:board", title: "Wrong" })], REF);
      expect(folded.title).toBe("Roadmap");
    });
  });

  describe("the baked watermark", () => {
    it("ignores a patch written before the creator last baked", () => {
      const folded = foldPatches(
        board({ baked: 250 }),
        [patch({ createdAt: 200, title: "Stale" })],
        REF,
      );
      expect(folded.title).toBe("Roadmap");
    });

    it("ignores a patch written in the same second as the bake", () => {
      const folded = foldPatches(
        board({ baked: 200 }),
        [patch({ createdAt: 200, title: "Stale" })],
        REF,
      );
      expect(folded.title).toBe("Roadmap");
    });

    it("still applies a patch written after the bake", () => {
      const folded = foldPatches(
        board({ baked: 250 }),
        [patch({ createdAt: 300, title: "Fresh" })],
        REF,
      );
      expect(folded.title).toBe("Fresh");
    });
  });
});

describe("mergePatch", () => {
  const previous = patch({
    title: "Renamed",
    columns: [{ id: "blocked", name: "Blocked", order: 2 }],
    columnsRemoved: ["done"],
    participantsAdded: [OUTSIDER],
    participantsRemoved: [WORKER],
  });

  it("keeps everything from the admin's earlier patch", () => {
    // The patch is replaceable, so publishing a bare second edit would drop the
    // first one's rows entirely.
    const merged = mergePatch(previous, {});
    expect(merged).toEqual({
      title: "Renamed",
      description: undefined,
      columns: [{ id: "blocked", name: "Blocked", order: 2 }],
      columnsRemoved: ["done"],
      participantsAdded: [OUTSIDER],
      participantsRemoved: [WORKER],
    });
  });

  it("starts from nothing when the admin has never patched this board", () => {
    expect(mergePatch(null, { title: "First" }).title).toBe("First");
  });

  it("lets a new title win over the old one", () => {
    expect(mergePatch(previous, { title: "Again" }).title).toBe("Again");
  });

  it("upserts a column by id rather than listing it twice", () => {
    const merged = mergePatch(previous, {
      columns: [{ id: "blocked", name: "On hold", order: 2 }],
    });
    expect(merged.columns).toEqual([{ id: "blocked", name: "On hold", order: 2 }]);
  });

  it("drops a column from the removed list when it is added back", () => {
    const merged = mergePatch(previous, { columns: [{ id: "done", name: "Done", order: 1 }] });
    expect(merged.columnsRemoved).toEqual([]);
    expect(merged.columns!.map((c) => c.id)).toContain("done");
  });

  it("stops carrying a column once it is removed", () => {
    const merged = mergePatch(previous, { columnsRemoved: ["blocked"] });
    expect(merged.columns).toEqual([]);
    expect(merged.columnsRemoved).toEqual(["done", "blocked"]);
  });

  it("moves a participant from removed to added when they are re-invited", () => {
    const merged = mergePatch(previous, { participantsAdded: [WORKER] });
    expect(merged.participantsAdded).toEqual([OUTSIDER, WORKER]);
    expect(merged.participantsRemoved).toEqual([]);
  });

  it("moves a participant from added to removed when they are dropped", () => {
    const merged = mergePatch(previous, { participantsRemoved: [OUTSIDER] });
    expect(merged.participantsAdded).toEqual([]);
    expect(merged.participantsRemoved).toEqual([WORKER, OUTSIDER]);
  });
});
