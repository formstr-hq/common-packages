import { generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import type { KanbanCtx } from "../contracts";
import { KANBAN_KINDS } from "../kinds";
import type { KanbanBoard } from "../types";

import { boardCoordinate, createBoard, fetchBoardByCoordinate, updateBoard } from "./boards";

const creatorSecret = generateSecretKey();
const adminSecret = generateSecretKey();
const workerSecret = generateSecretKey();
const ADMIN = getPublicKey(adminSecret);
const WORKER = getPublicKey(workerSecret);

let runtime: FakeRuntime;
let creator: KanbanCtx;
let admin: KanbanCtx;
let worker: KanbanCtx;

beforeEach(() => {
  runtime = new FakeRuntime();
  creator = makeCtx({ signer: fakeSigner(creatorSecret), runtime });
  admin = makeCtx({ signer: fakeSigner(adminSecret), runtime });
  worker = makeCtx({ signer: fakeSigner(workerSecret), runtime });
});

const newBoard = (): Promise<KanbanBoard> =>
  createBoard(creator, {
    title: "Roadmap",
    columns: [{ id: "todo", name: "To Do", order: 0 }],
    admins: [ADMIN],
    participants: [WORKER],
  });

const reload = (board: KanbanBoard, ctx = creator) =>
  fetchBoardByCoordinate(ctx, boardCoordinate(board));

describe("updateBoard routing", () => {
  it("writes the board event itself for the creator", async () => {
    const board = await newBoard();
    runtime.published.length = 0;

    await updateBoard(creator, board, { title: "Renamed" });

    expect(runtime.published.map((e) => e.kind)).toEqual([KANBAN_KINDS.publicBoard]);
  });

  it("writes a patch for an admin, leaving the board event alone", async () => {
    const board = await newBoard();
    runtime.published.length = 0;

    await updateBoard(admin, board, { title: "Renamed by the admin" });

    expect(runtime.published.map((e) => e.kind)).toEqual([KANBAN_KINDS.adminPatch]);
    expect(runtime.published[0].pubkey).toBe(ADMIN);
  });

  it("refuses a participant, who may write cards but not the board", async () => {
    const board = await newBoard();
    await expect(updateBoard(worker, board, { title: "Nope" })).rejects.toThrow(/not an admin/i);
  });

  it("refuses a stranger", async () => {
    const stranger = makeCtx({ signer: fakeSigner(generateSecretKey()), runtime });
    await expect(updateBoard(stranger, await newBoard(), { title: "Nope" })).rejects.toThrow(
      /not an admin/i,
    );
  });
});

describe("reading a board with patches", () => {
  it("shows an admin's new column to everyone", async () => {
    const board = await newBoard();
    await updateBoard(admin, board, {
      columns: [
        { id: "todo", name: "To Do", order: 0 },
        { id: "blocked", name: "Blocked", order: 1 },
      ],
    });

    expect((await reload(board))!.columns.map((c) => c.id)).toEqual(["todo", "blocked"]);
  });

  it("shows a participant an admin invited", async () => {
    const board = await newBoard();
    const newcomer = getPublicKey(generateSecretKey());
    await updateBoard(admin, board, { participants: [WORKER, newcomer] });

    expect((await reload(board))!.participants).toContain(newcomer);
  });

  it("drops the patch once the creator demotes its author, rather than baking it in", async () => {
    const board = await newBoard();
    await updateBoard(admin, board, { title: "Renamed by the admin" });
    expect((await reload(board))!.title).toBe("Renamed by the admin");

    const current = (await reload(board))!;
    await updateBoard(creator, current, { admins: [] });

    expect((await reload(board))!.title).toBe("Roadmap");
  });
});

describe("baking", () => {
  it("folds an admin's change into the board event when the creator saves", async () => {
    const board = await newBoard();
    await updateBoard(admin, board, {
      columns: [
        { id: "todo", name: "To Do", order: 0 },
        { id: "blocked", name: "Blocked", order: 1 },
      ],
    });

    const current = (await reload(board))!;
    await updateBoard(creator, current, { description: "now with a plan" });

    // Straight off the creator's own event, with no patch folded in: this is
    // what kanbanstr and any other NIP-100 client will now see.
    const base = runtime.published.at(-1)!;
    expect(base.kind).toBe(KANBAN_KINDS.publicBoard);
    expect(base.tags).toContainEqual(["col", "blocked", "Blocked", "1"]);
    expect(base.tags.some((t) => t[0] === "baked")).toBe(true);
  });

  it("makes the folded patch inert rather than applying it twice", async () => {
    const board = await newBoard();
    await updateBoard(admin, board, { title: "Admin title" });

    const current = (await reload(board))!;
    await updateBoard(creator, current, { title: "Creator title" });

    // Without the watermark the stale patch would re-apply on the next read and
    // silently undo the creator's rename.
    expect((await reload(board))!.title).toBe("Creator title");
  });

  it("lets the admin patch again after a bake", async () => {
    const board = await newBoard();
    await updateBoard(admin, board, { title: "Admin title" });
    await updateBoard(creator, (await reload(board))!, { title: "Creator title" });

    await updateBoard(admin, (await reload(board))!, { title: "Admin again" });

    expect((await reload(board))!.title).toBe("Admin again");
  });
});
