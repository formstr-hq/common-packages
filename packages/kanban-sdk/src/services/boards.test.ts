import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { decryptWithViewKey, generateViewKey } from "../crypto/viewKey";
import { KANBAN_KINDS } from "../kinds";
import { fetchBoardLists, removeBoardFromList } from "./boardLists";
import {
  createBoard,
  createPrivateBoard,
  fetchBoardByCoordinate,
  fetchBoards,
  fetchPrivateBoardByCoordinate,
  fetchPrivateBoards,
  updateBoard,
  updatePrivateBoard,
} from "./boards";

describe("createBoard", () => {
  it("publishes a 30301 with a random d tag and returns the board", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, {
      title: "Roadmap",
      columns: [{ id: "c1", name: "To Do", order: 0 }],
    });

    expect(board.title).toBe("Roadmap");
    expect(board.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ctx.runtime.published).toHaveLength(1);
    expect(ctx.runtime.published[0].kind).toBe(30301);
  });

  it("round-trips through fetchBoardByCoordinate", async () => {
    const ctx = makeCtx();
    const created = await createBoard(ctx, { title: "Roadmap", columns: [] });
    const fetched = await fetchBoardByCoordinate(ctx, `30301:${created.pubkey}:${created.id}`);
    expect(fetched?.title).toBe("Roadmap");
  });
});

describe("updateBoard", () => {
  it("preserves tags the model does not know about", async () => {
    const ctx = makeCtx();
    const created = await createBoard(ctx, { title: "Roadmap", columns: [] });

    // Simulate a tag written by some other client.
    const stored = ctx.runtime.published[0];
    ctx.runtime.seed({ ...stored, tags: [...stored.tags, ["experimental", "keep me"]] });

    const reloaded = await fetchBoardByCoordinate(ctx, `30301:${created.pubkey}:${created.id}`);
    const updated = await updateBoard(ctx, reloaded!, { title: "Roadmap v2" });

    const published = ctx.runtime.published.at(-1)!;
    expect(published.tags).toContainEqual(["title", "Roadmap v2"]);
    expect(published.tags).toContainEqual(["experimental", "keep me"]);
    expect(updated.title).toBe("Roadmap v2");
  });

  it("preserves the nozap flag across an unrelated edit", async () => {
    const ctx = makeCtx();
    const created = await createBoard(ctx, { title: "X", columns: [], noZap: true });
    const updated = await updateBoard(ctx, created, { title: "Y" });
    expect(updated.noZap).toBe(true);
    expect(ctx.runtime.published.at(-1)!.tags).toContainEqual(["nozap"]);
  });

  it("forces a strictly newer created_at", async () => {
    const ctx = makeCtx();
    const created = await createBoard(ctx, { title: "X", columns: [] });
    const updated = await updateBoard(ctx, created, { title: "Y" });
    expect(updated.createdAt).toBeGreaterThan(created.createdAt);
  });
});

describe("fetchBoards", () => {
  it("filters by author", async () => {
    const alice = fakeSigner();
    const runtime = new FakeRuntime();
    const aliceCtx = makeCtx({ signer: alice, runtime });
    const bobCtx = makeCtx({ runtime });

    await createBoard(aliceCtx, { title: "Alice board", columns: [] });
    await createBoard(bobCtx, { title: "Bob board", columns: [] });

    const boards = await fetchBoards(aliceCtx, { authors: [await alice.getPublicKey()] });
    expect(boards.map((b) => b.title)).toEqual(["Alice board"]);
  });

  it("filters by maintainer", async () => {
    const runtime = new FakeRuntime();
    const ctx = makeCtx({ runtime });
    const maintainer = "c".repeat(64);

    await createBoard(ctx, { title: "Shared", columns: [], maintainers: [maintainer] });
    await createBoard(ctx, { title: "Solo", columns: [] });

    const boards = await fetchBoards(ctx, { maintainedBy: maintainer });
    expect(boards.map((b) => b.title)).toEqual(["Shared"]);
  });

  it("returns one entry per board even with several versions on the relay", async () => {
    const ctx = makeCtx();
    const created = await createBoard(ctx, { title: "V1", columns: [] });
    await updateBoard(ctx, created, { title: "V2" });

    const boards = await fetchBoards(ctx, { authors: [created.pubkey] });
    expect(boards).toHaveLength(1);
    expect(boards[0].title).toBe("V2");
  });
});

// ── Private path (Plan 2) ───────────────────────────────

describe("createPrivateBoard", () => {
  it("publishes a 32301 carrying nothing but a d tag", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3 Roadmap",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
      private: true,
    });

    const event = ctx.runtime.published.find((e) => e.kind === KANBAN_KINDS.privateBoard)!;
    expect(event.tags).toEqual([["d", board.id]]);
    expect(event.content).not.toContain("Q3 Roadmap");
    expect(event.content).not.toContain("To Do");
    expect(board.isPrivate).toBe(true);
    expect(board.viewKey!.startsWith("nsec1")).toBe(true);
  });

  it("uses a random d tag, never one derived from the title", async () => {
    const ctx = makeCtx();
    const first = await createPrivateBoard(ctx, { title: "Same", columns: [], private: true });
    const second = await createPrivateBoard(ctx, { title: "Same", columns: [], private: true });
    expect(first.board.id).not.toBe(second.board.id);
    expect(first.board.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("encrypts the payload under the board view key", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3 Roadmap",
      columns: [],
      private: true,
    });

    const event = ctx.runtime.published.find((e) => e.kind === KANBAN_KINDS.privateBoard)!;
    const inner = JSON.parse(await decryptWithViewKey(board.viewKey!, event.content));
    expect(inner).toContainEqual(["title", "Q3 Roadmap"]);
  });

  it("links the board into an auto-created list, with the view key", async () => {
    const ctx = makeCtx();
    const { board, list } = await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [],
      private: true,
    });

    expect(list.title).toBe("My Boards");
    const [stored] = (await fetchBoardLists(ctx))[0].boards;
    expect(stored.coordinate).toBe(`${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`);
    expect(stored.viewKey).toBe(board.viewKey);
    expect(stored.role).toBe("owner");
  });

  it("still links when the supplied listId does not resolve", async () => {
    const ctx = makeCtx();
    await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [],
      private: true,
      listId: "no-such-list",
    });
    expect((await fetchBoardLists(ctx))[0].boards).toHaveLength(1);
  });

  it("reuses a supplied view key instead of minting one", async () => {
    const ctx = makeCtx();
    const key = generateViewKey();
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [],
      private: true,
      viewKey: key.nsec,
    });
    expect(board.viewKey).toBe(key.nsec);
  });
});

describe("fetchPrivateBoards", () => {
  it("walks the board lists and decrypts each board", async () => {
    const ctx = makeCtx();
    await createPrivateBoard(ctx, {
      title: "Q3 Roadmap",
      description: "desc",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
      maintainers: ["a".repeat(64)],
      private: true,
    });

    const boards = await fetchPrivateBoards(ctx);
    expect(boards).toHaveLength(1);
    expect(boards[0].title).toBe("Q3 Roadmap");
    expect(boards[0].columns.map((c) => c.name)).toEqual(["To Do"]);
    expect(boards[0].maintainers).toEqual(["a".repeat(64)]);
    expect(boards[0].viewKey).toBeDefined();
  });

  it("returns nothing when the user has no lists", async () => {
    expect(await fetchPrivateBoards(makeCtx())).toEqual([]);
  });
});

describe("fetchPrivateBoardByCoordinate", () => {
  it("returns null for the wrong view key rather than throwing", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, { title: "Q3", columns: [], private: true });
    const coordinate = `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`;

    expect(await fetchPrivateBoardByCoordinate(ctx, coordinate, generateViewKey().nsec)).toBeNull();
  });

  it("rejects a public coordinate", async () => {
    await expect(
      fetchPrivateBoardByCoordinate(makeCtx(), `30301:${"c".repeat(64)}:x`, "nsec1aaa"),
    ).rejects.toThrow(/Board not found/);
  });
});

describe("updatePrivateBoard", () => {
  it("re-encrypts under the SAME key and strictly supersedes", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
      private: true,
    });

    const updated = await updatePrivateBoard(ctx, board, { title: "Q4" });

    expect(updated.viewKey).toBe(board.viewKey);
    expect(updated.title).toBe("Q4");
    expect(updated.createdAt).toBeGreaterThan(board.createdAt);
    expect((await fetchPrivateBoards(ctx))[0].title).toBe("Q4");
  });

  it("renaming a column keeps its id, so no card is orphaned", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
      private: true,
    });

    const updated = await updatePrivateBoard(ctx, board, {
      columns: [{ id: "col-1", name: "Backlog", order: 0 }],
    });
    expect(updated.columns).toEqual([{ id: "col-1", name: "Backlog", order: 0 }]);
  });

  it("preserves an inner tag the model does not know about", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, { title: "Q3", columns: [], private: true });
    board.rawTags = [...board.rawTags, ["future-tag", "keep me"]];

    const updated = await updatePrivateBoard(ctx, board, { title: "Q4" });
    expect(updated.rawTags).toContainEqual(["future-tag", "keep me"]);
  });

  it("refuses an editor who is not the board author", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, { title: "Q3", columns: [], private: true });

    const intruder = makeCtx({ runtime: ctx.runtime });
    await expect(updatePrivateBoard(intruder, board, { title: "Hijacked" })).rejects.toThrow(
      /is not the author/,
    );
  });

  it("throws ViewKeyRequiredError when the key is neither passed nor listed", async () => {
    const ctx = makeCtx();
    const { board } = await createPrivateBoard(ctx, { title: "Q3", columns: [], private: true });
    const list = (await fetchBoardLists(ctx))[0];
    await removeBoardFromList(ctx, list, `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`);

    await expect(
      updatePrivateBoard(ctx, { ...board, viewKey: undefined }, { title: "Q4" }),
    ).rejects.toThrow(/No view key/);
  });
});
