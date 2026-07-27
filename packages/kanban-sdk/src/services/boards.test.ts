import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { createBoard, fetchBoardByCoordinate, fetchBoards, updateBoard } from "./boards";

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
