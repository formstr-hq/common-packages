import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import type { KanbanBoard } from "../types";
import { blindedPointer } from "../crypto/blindedPointer";
import { encryptWithViewKey, generateViewKey, viewKeyFromNsec } from "../crypto/viewKey";
import { KANBAN_KINDS } from "../kinds";
import { createBoard, createPrivateBoard } from "./boards";
import {
  boardPointer,
  canEditCards,
  createCard,
  createPrivateCard,
  fetchCards,
  fetchPrivateCards,
  moveCard,
  updateCard,
  updatePrivateCard,
} from "./cards";

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

// ── Private path (Plan 2) ───────────────────────────────

async function privateBoardFixture() {
  const secret = generateSecretKey();
  const ctx = makeCtx({ signer: fakeSigner(secret) });
  const { board } = await createPrivateBoard(ctx, {
    title: "Q3",
    columns: [
      { id: "col-1", name: "To Do", order: 0 },
      { id: "col-2", name: "Doing", order: 1 },
    ],
    private: true,
  });
  return { ctx, board, secret };
}

describe("createPrivateCard", () => {
  it("publishes a 32302 carrying only d and b", async () => {
    const { ctx, board } = await privateBoardFixture();
    const card = await createPrivateCard(ctx, board, { title: "Ship it", status: "col-1" });

    const event = ctx.runtime.published.find((e) => e.kind === KANBAN_KINDS.privateCard)!;
    expect(event.tags.map((t) => t[0]).sort()).toEqual(["b", "d"]);
    expect(event.content).not.toContain("Ship it");
    expect(card.isPrivate).toBe(true);
  });

  it("writes the blinded pointer the spec derives, not the coordinate", async () => {
    const { ctx, board } = await privateBoardFixture();
    await createPrivateCard(ctx, board, { title: "Ship it" });

    const event = ctx.runtime.published.find((e) => e.kind === KANBAN_KINDS.privateCard)!;
    const pointer = event.tags.find((t) => t[0] === "b")![1];
    expect(pointer).toBe(
      blindedPointer(
        viewKeyFromNsec(board.viewKey!).pubkey,
        `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`,
      ),
    );
    expect(pointer).not.toContain(board.id);
    expect(pointer).not.toContain(board.pubkey);
  });

  it("stores the column id in s, so a rename cannot orphan the card", async () => {
    const { ctx, board } = await privateBoardFixture();
    const card = await createPrivateCard(ctx, board, { title: "Ship it", status: "col-1" });
    expect(card.status).toBe("col-1");
  });

  it("appends to the column when no rank is given", async () => {
    const { ctx, board } = await privateBoardFixture();
    const first = await createPrivateCard(ctx, board, { title: "A", status: "col-1" });
    const second = await createPrivateCard(ctx, board, { title: "B", status: "col-1" });
    expect(second.rank).toBeGreaterThan(first.rank);
  });

  it("refuses a writer who is not a maintainer", async () => {
    const { ctx, board } = await privateBoardFixture();
    const stranger = makeCtx({ runtime: ctx.runtime });
    await expect(createPrivateCard(stranger, { ...board }, { title: "Injected" })).rejects.toThrow(
      /is not a maintainer/,
    );
  });
});

describe("fetchPrivateCards", () => {
  it("finds cards by blinded pointer and decrypts them", async () => {
    const { ctx, board } = await privateBoardFixture();
    await createPrivateCard(ctx, board, { title: "A", status: "col-1" });
    await createPrivateCard(ctx, board, { title: "B", status: "col-2" });

    const cards = await fetchPrivateCards(ctx, board);
    expect(cards.map((c) => c.title).sort()).toEqual(["A", "B"]);
  });

  it("sorts by rank", async () => {
    const { ctx, board } = await privateBoardFixture();
    await createPrivateCard(ctx, board, { title: "second", status: "col-1", rank: 20 });
    await createPrivateCard(ctx, board, { title: "first", status: "col-1", rank: 10 });

    expect((await fetchPrivateCards(ctx, board)).map((c) => c.title)).toEqual(["first", "second"]);
  });

  it("discards a card published by a key holder who is not a maintainer", async () => {
    const { ctx, board } = await privateBoardFixture();
    await createPrivateCard(ctx, board, { title: "Legit", status: "col-1" });

    // A member holds the same key a maintainer does and can publish a card with a
    // valid pointer. Only display is restricted (doc 05 §7 step 3, doc 07 §B3).
    const intruderKey = generateSecretKey();
    const inner: string[][] = [
      ["d", "injected"],
      ["a", `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`],
      ["title", "Injected"],
      ["rank", "5"],
    ];
    ctx.runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateCard,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "injected"],
            ["b", boardPointer(board, board.viewKey!)],
          ],
          content: await encryptWithViewKey(board.viewKey!, JSON.stringify(inner)),
        },
        intruderKey,
      ),
    );

    expect((await fetchPrivateCards(ctx, board)).map((c) => c.title)).toEqual(["Legit"]);
  });

  it("discards a card whose inner a tag points at another board", async () => {
    const { ctx, board, secret } = await privateBoardFixture();
    const inner: string[][] = [
      ["d", "crossposted"],
      ["a", `${KANBAN_KINDS.privateBoard}:${"9".repeat(64)}:other-board`],
      ["title", "Crossposted"],
      ["rank", "5"],
    ];
    ctx.runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateCard,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "crossposted"],
            ["b", boardPointer(board, board.viewKey!)],
          ],
          content: await encryptWithViewKey(board.viewKey!, JSON.stringify(inner)),
        },
        secret,
      ),
    );

    expect(await fetchPrivateCards(ctx, board)).toEqual([]);
  });

  it("discards a card it cannot decrypt", async () => {
    const { ctx, board, secret } = await privateBoardFixture();
    ctx.runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateCard,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "garbage"],
            ["b", boardPointer(board, board.viewKey!)],
          ],
          content: await encryptWithViewKey(generateViewKey().nsec, JSON.stringify([["d", "x"]])),
        },
        secret,
      ),
    );

    expect(await fetchPrivateCards(ctx, board)).toEqual([]);
  });

  it("resolves one d written by two maintainers in the same second by lowest event id", async () => {
    // The multi-author collision of doc 07 §A3: because cards are author-signed,
    // two maintainers editing one card produce two COORDINATES sharing a `d`. A
    // relay stores both — it only replaces within one coordinate — so resolving
    // them is the client's job, and getting the tie-break wrong silently drops
    // one maintainer's edit.
    const ownerSecret = generateSecretKey();
    const otherSecret = generateSecretKey();
    const ctx = makeCtx({ signer: fakeSigner(ownerSecret) });
    const { board } = await createPrivateBoard(ctx, {
      title: "Q3",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
      maintainers: [getPublicKey(otherSecret)],
      private: true,
    });

    const createdAt = Math.floor(Date.now() / 1000);
    const pointer = boardPointer(board, board.viewKey!);
    const payload = async (title: string) =>
      encryptWithViewKey(
        board.viewKey!,
        JSON.stringify([
          ["d", "contended"],
          ["a", `${KANBAN_KINDS.privateBoard}:${board.pubkey}:${board.id}`],
          ["title", title],
          ["rank", "5"],
        ]),
      );

    const versions = [
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateCard,
          created_at: createdAt,
          tags: [
            ["d", "contended"],
            ["b", pointer],
          ],
          content: await payload("owner wrote this"),
        },
        ownerSecret,
      ),
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateCard,
          created_at: createdAt,
          tags: [
            ["d", "contended"],
            ["b", pointer],
          ],
          content: await payload("maintainer wrote this"),
        },
        otherSecret,
      ),
    ];
    for (const version of versions) ctx.runtime.seed(version);

    const winner = versions.reduce((a, b) => (a.id < b.id ? a : b));
    const cards = await fetchPrivateCards(ctx, board);
    expect(cards).toHaveLength(1);
    expect(cards[0].eventId).toBe(winner.id);
  });
});

describe("updatePrivateCard", () => {
  it("re-encrypts under the board key and strictly supersedes", async () => {
    const { ctx, board } = await privateBoardFixture();
    const card = await createPrivateCard(ctx, board, { title: "Draft", status: "col-1" });
    const updated = await updatePrivateCard(ctx, board, card, { title: "Final" });

    expect(updated.createdAt).toBeGreaterThan(card.createdAt);
    expect((await fetchPrivateCards(ctx, board)).map((c) => c.title)).toEqual(["Final"]);
  });

  it("keeps a tracker card tracking across an edit", async () => {
    const { ctx, board } = await privateBoardFixture();
    const card = await createPrivateCard(ctx, board, { title: "Tracker", status: "col-1" });
    card.rawTags = [...card.rawTags, ["k", "1621"], ["e", "f".repeat(64)]];

    const updated = await updatePrivateCard(ctx, board, card, { title: "Tracker v2" });
    expect(updated.trackedKind).toBe(1621);
    expect(updated.trackedRef).toEqual({ eventId: "f".repeat(64) });
  });

  it("keeps the same blinded pointer, so the card stays on the board", async () => {
    const { ctx, board } = await privateBoardFixture();
    const card = await createPrivateCard(ctx, board, { title: "A", status: "col-1" });
    await updatePrivateCard(ctx, board, card, { title: "B" });

    const pointers = ctx.runtime.published
      .filter((e) => e.kind === KANBAN_KINDS.privateCard)
      .map((e) => e.tags.find((t) => t[0] === "b")![1]);
    expect(new Set(pointers).size).toBe(1);
  });
});
