import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import type { KanbanBoard } from "../types";
import { createBoard } from "./boards";
import { canEditCards, createCard, fetchCards, moveCard, updateCard } from "./cards";

function boardStub(pubkey: string, maintainers: string[]): KanbanBoard {
  return { pubkey, maintainers } as KanbanBoard;
}

describe("canEditCards", () => {
  it("allows the board owner", () => {
    expect(canEditCards(boardStub("a".repeat(64), []), "a".repeat(64))).toBe(true);
  });

  it("allows a listed maintainer", () => {
    expect(canEditCards(boardStub("a".repeat(64), ["b".repeat(64)]), "b".repeat(64))).toBe(true);
  });

  it("rejects a stranger", () => {
    expect(canEditCards(boardStub("a".repeat(64), []), "c".repeat(64))).toBe(false);
  });
});

describe("createCard", () => {
  it("publishes a 30302 pointing at the board", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, {
      title: "B",
      columns: [{ id: "c1", name: "To Do", order: 0 }],
    });
    const card = await createCard(ctx, board, { title: "Task", status: "To Do" });

    expect(card.title).toBe("Task");
    expect(card.boardCoordinate).toBe(`30301:${board.pubkey}:${board.id}`);
    expect(ctx.runtime.published.at(-1)!.kind).toBe(30302);
  });

  it("rejects a non-maintainer", async () => {
    const runtime = new FakeRuntime();
    const ownerCtx = makeCtx({ runtime });
    const board = await createBoard(ownerCtx, { title: "B", columns: [] });

    const strangerCtx = makeCtx({ signer: fakeSigner(), runtime });
    await expect(createCard(strangerCtx, board, { title: "Nope" })).rejects.toThrow(
      /not a maintainer/i,
    );
  });

  it("assigns an increasing rank within a column", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, { title: "B", columns: [] });
    const first = await createCard(ctx, board, { title: "A", status: "To Do" });
    const second = await createCard(ctx, board, { title: "B", status: "To Do" });
    expect(second.rank).toBeGreaterThan(first.rank);
  });
});

describe("updateCard", () => {
  it("preserves tracker tags across an edit", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, { title: "B", columns: [] });
    const card = await createCard(ctx, board, { title: "Tracker", status: "To Do" });

    // Simulate a tracker card: add k/refs tags outside the model.
    const stored = ctx.runtime.published.at(-1)!;
    ctx.runtime.seed({
      ...stored,
      tags: [...stored.tags, ["k", "1621"], ["e", "f".repeat(64)]],
    });
    const reloaded = (await fetchCards(ctx, board)).find((c) => c.id === card.id)!;

    const updated = await updateCard(ctx, board, reloaded, { status: "Done" });

    const published = ctx.runtime.published.at(-1)!;
    expect(published.tags).toContainEqual(["k", "1621"]);
    expect(published.tags).toContainEqual(["e", "f".repeat(64)]);
    expect(updated.status).toBe("Done");
    expect(updated.trackedKind).toBe(1621);
  });

  it("forces a strictly newer created_at", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, { title: "B", columns: [] });
    const card = await createCard(ctx, board, { title: "T" });
    const updated = await updateCard(ctx, board, card, { title: "T2" });
    expect(updated.createdAt).toBeGreaterThan(card.createdAt);
  });
});

describe("moveCard", () => {
  it("changes status and ranks the card between its new neighbours", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, { title: "B", columns: [] });
    const a = await createCard(ctx, board, { title: "A", status: "Done" });
    const b = await createCard(ctx, board, { title: "B", status: "Done" });
    const mover = await createCard(ctx, board, { title: "M", status: "To Do" });

    const moved = await moveCard(ctx, board, [a, b, mover], mover.id, "Done", 1);

    expect(moved.status).toBe("Done");
    expect(moved.rank).toBeGreaterThan(a.rank);
    expect(moved.rank).toBeLessThan(b.rank);
  });
});

describe("fetchCards", () => {
  it("drops cards published by non-maintainers", async () => {
    const runtime = new FakeRuntime();
    const ownerCtx = makeCtx({ runtime });
    const board = await createBoard(ownerCtx, { title: "B", columns: [] });
    await createCard(ownerCtx, board, { title: "Legit" });

    // A stranger publishes a card carrying the board's `a` tag directly.
    const stranger = fakeSigner();
    const strangerEvent = await stranger.signEvent({
      kind: 30302,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ["d", "intruder"],
        ["title", "Spam"],
        ["a", `30301:${board.pubkey}:${board.id}`],
      ],
      content: "",
    });
    await runtime.publish([], strangerEvent);

    const cards = await fetchCards(ownerCtx, board);
    expect(cards.map((c) => c.title)).toEqual(["Legit"]);
  });

  it("returns cards sorted by rank", async () => {
    const ctx = makeCtx();
    const board = await createBoard(ctx, { title: "B", columns: [] });
    await createCard(ctx, board, { title: "First", status: "To Do" });
    await createCard(ctx, board, { title: "Second", status: "To Do" });

    const cards = await fetchCards(ctx, board);
    expect(cards.map((c) => c.title)).toEqual(["First", "Second"]);
  });
});
