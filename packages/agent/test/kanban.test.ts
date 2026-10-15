import { describe, it, expect, vi, beforeEach } from "vitest";

const ME = "a".repeat(64);
const BOARD = "30301:" + "b".repeat(64) + ":board1";

const kanban = vi.hoisted(() => ({
  myPubkey: vi.fn(),
  fetchMyBoards: vi.fn(),
  summarizeBoard: vi.fn((b: any) => ({
    coordinate: b.coordinate,
    title: b.title,
    description: b.description ?? "",
    columns: b.columns ?? ["To Do"],
    isPrivate: false,
    admins: [],
    participants: [],
    createdAt: 0,
  })),
  resolveBoard: vi.fn(),
  listCards: vi.fn(),
  summarizeCard: vi.fn((c: any) => ({
    id: c.id,
    title: c.title,
    description: "",
    status: c.status,
    assignees: c.assignees ?? [],
    labels: [],
    board: c.boardCoordinate,
    createdAt: 0,
  })),
  listAssignments: vi.fn(),
  openAssignments: vi.fn(),
  claimCard: vi.fn(),
  createBoard: vi.fn(),
  columnsFromNames: vi.fn((names: string[]) => names.map((n, order) => ({ id: n, name: n, order }))),
  DEFAULT_COLUMNS: [{ id: "todo", name: "To Do", order: 0 }],
  createCard: vi.fn(),
  cardDraft: vi.fn((_b: unknown, input: any) => ({ title: input.title, status: input.status })),
  findCard: vi.fn(),
  updateCard: vi.fn(),
  moveCard: vi.fn(),
  addComment: vi.fn(),
  deleteCard: vi.fn(),
  deleteBoard: vi.fn(),
  columnFor: vi.fn(),
  statusFor: vi.fn((_b: unknown, c: any) => c.name),
}));

vi.mock("../src/services", () => ({ kanban }));

import { CONFIRM_REQUIRED_PREFIX } from "../src/safety";
import { kanbanTools } from "../src/tools/kanban";
import type { ToolCtx } from "../src/tools/types";

type Tools = Map<string, { handler: (a: any) => Promise<any> }>;

function register(ctx: ToolCtx): Tools {
  const tools: Tools = new Map();
  for (const t of kanbanTools) {
    if (t.write && !ctx.allowWrites) continue;
    tools.set(t.name, { handler: (a: any) => t.handler(a, ctx) });
  }
  return tools;
}

const ctx: ToolCtx = { allowWrites: true };
const board = {
  id: "board1",
  pubkey: "b".repeat(64),
  title: "Sprint",
  columns: [
    { id: "todo", name: "To Do", order: 0 },
    { id: "done", name: "Done", order: 1 },
  ],
  isPrivate: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  kanban.myPubkey.mockResolvedValue(ME);
});

describe("kanban tools", () => {
  it("exposes 12 tools, 6 of them gated", () => {
    expect(kanbanTools).toHaveLength(12);
    expect(kanbanTools.filter((t) => t.write)).toHaveLength(6);
  });

  it("create_kanban_board defaults the columns and returns a coordinate", async () => {
    kanban.createBoard.mockResolvedValue({ ...board, coordinate: BOARD });
    const res = await register(ctx).get("create_kanban_board")!.handler({ title: "Sprint" });
    expect(res.ok).toBe(true);
    expect(res.data.coordinate).toBe(BOARD);
    expect(kanban.createBoard).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sprint", columns: kanban.DEFAULT_COLUMNS }),
    );
  });

  it("create_kanban_card resolves the board then creates the card", async () => {
    kanban.resolveBoard.mockResolvedValue(board);
    kanban.createCard.mockResolvedValue({ id: "c1", title: "Fix", boardCoordinate: BOARD });
    const res = await register(ctx)
      .get("create_kanban_card")!
      .handler({ board: BOARD, title: "Fix", assignees: [ME] });
    expect(res.ok).toBe(true);
    expect(res.data.id).toBe("c1");
  });

  it("create_kanban_card fails when the board does not resolve", async () => {
    kanban.resolveBoard.mockResolvedValue(null);
    const res = await register(ctx).get("create_kanban_card")!.handler({ board: BOARD, title: "x" });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("NOT_FOUND");
  });

  it("list_my_kanban_cards returns assignments", async () => {
    kanban.listAssignments.mockResolvedValue([
      { id: "c1", title: "Fix", board: BOARD, status: "To Do" },
    ]);
    const res = await register(ctx).get("list_my_kanban_cards")!.handler({});
    expect(res.ok).toBe(true);
    expect(res.data.assignee).toBe(ME);
    expect(res.data.cards).toHaveLength(1);
  });

  it("move_kanban_card refuses without confirm:true", async () => {
    const res = await register(ctx)
      .get("move_kanban_card")!
      .handler({ board: BOARD, cardId: "c1", status: "Done" });
    expect(res.ok).toBe(false);
    expect(res.text.startsWith(CONFIRM_REQUIRED_PREFIX)).toBe(true);
    expect(kanban.moveCard).not.toHaveBeenCalled();
  });

  it("move_kanban_card maps the column name to the board's wire status", async () => {
    kanban.resolveBoard.mockResolvedValue(board);
    kanban.columnFor.mockReturnValue({ id: "done", name: "Done", order: 1 });
    kanban.findCard.mockResolvedValue({ id: "c1", title: "Fix" });
    kanban.moveCard.mockResolvedValue({ id: "c1", title: "Fix", status: "Done", boardCoordinate: BOARD });
    const res = await register(ctx)
      .get("move_kanban_card")!
      .handler({ board: BOARD, cardId: "c1", status: "Done", confirm: true });
    expect(res.ok).toBe(true);
    expect(kanban.moveCard).toHaveBeenCalledWith(board, "c1", "Done", undefined);
  });

  it("gated tools are invisible without allowWrites", () => {
    const ro = register({ allowWrites: false });
    expect(ro.has("move_kanban_card")).toBe(false);
    expect(ro.has("create_kanban_board")).toBe(true);
  });

  it("list_kanban_inbox returns the open assignments to pick up", async () => {
    kanban.openAssignments.mockResolvedValue([{ id: "c1", title: "Do it", board: BOARD, status: "To Do" }]);
    const res = await register(ctx).get("list_kanban_inbox")!.handler({});
    expect(res.ok).toBe(true);
    expect(res.data.cards).toHaveLength(1);
  });

  it("claim_kanban_card refuses a card not assigned to the agent", async () => {
    kanban.resolveBoard.mockResolvedValue(board);
    kanban.findCard.mockResolvedValue({ id: "c1", title: "x", assignees: ["other"] });
    const res = await register(ctx)
      .get("claim_kanban_card")!
      .handler({ board: BOARD, cardId: "c1", confirm: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("NOT_ASSIGNED");
    expect(kanban.claimCard).not.toHaveBeenCalled();
  });

  it("claim_kanban_card claims an assigned card and reports claimed:true", async () => {
    kanban.resolveBoard.mockResolvedValue(board);
    kanban.findCard.mockResolvedValue({ id: "c1", title: "x", assignees: [ME] });
    kanban.claimCard.mockResolvedValue({
      card: { id: "c1", title: "x", status: "In Progress", boardCoordinate: BOARD },
      claimed: true,
    });
    const res = await register(ctx)
      .get("claim_kanban_card")!
      .handler({ board: BOARD, cardId: "c1", confirm: true });
    expect(res.ok).toBe(true);
    expect(res.data.claimed).toBe(true);
  });
});
