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
  listComments: vi.fn(),
  deleteCard: vi.fn(),
  deleteBoard: vi.fn(),
  columnFor: vi.fn(),
  statusFor: vi.fn((_b: unknown, c: any) => c.name),
  listInvitations: vi.fn(),
  acceptInvitation: vi.fn(),
  dismissInvitation: vi.fn(),
  inviteMembers: vi.fn(),
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
  it("exposes 17 tools, 9 of them gated", () => {
    expect(kanbanTools).toHaveLength(17);
    expect(kanbanTools.filter((t) => t.write)).toHaveLength(9);
  });

  it("create_kanban_board defaults the columns and is private by default", async () => {
    kanban.createBoard.mockResolvedValue({ ...board, coordinate: BOARD });
    const res = await register(ctx).get("create_kanban_board")!.handler({ title: "Sprint" });
    expect(res.ok).toBe(true);
    expect(res.data.coordinate).toBe(BOARD);
    expect(kanban.createBoard).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Sprint", columns: kanban.DEFAULT_COLUMNS, private: true }),
    );
  });

  it("create_kanban_board honors private:false for a public board", async () => {
    kanban.createBoard.mockResolvedValue({ ...board, coordinate: BOARD });
    await register(ctx).get("create_kanban_board")!.handler({ title: "Open", private: false });
    expect(kanban.createBoard).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Open", private: false }),
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

  it("list_kanban_comments returns a card's comments from a private board", async () => {
    kanban.resolveBoard.mockResolvedValue({ ...board, isPrivate: true });
    kanban.listComments.mockResolvedValue([
      { id: "m1", cardId: "c1", authorPubkey: ME, content: "hi", mentions: [], createdAt: 100 },
    ]);
    const res = await register(ctx).get("list_kanban_comments")!.handler({ board: BOARD, cardId: "c1" });
    expect(res.ok).toBe(true);
    expect(kanban.listComments).toHaveBeenCalledWith(expect.anything(), "c1");
    expect(res.data.comments).toEqual([
      expect.objectContaining({ id: "m1", cardId: "c1", author: ME, content: "hi" }),
    ]);
  });

  it("list_kanban_comments refuses a public board and an unknown board", async () => {
    kanban.resolveBoard.mockResolvedValue(board);
    const pub = await register(ctx).get("list_kanban_comments")!.handler({ board: BOARD });
    expect(pub.ok).toBe(false);
    expect(kanban.listComments).not.toHaveBeenCalled();
    kanban.resolveBoard.mockResolvedValue(null);
    const none = await register(ctx).get("list_kanban_comments")!.handler({ board: BOARD });
    expect(none.ok).toBe(false);
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

  it("list_kanban_invitations lists invites without leaking view keys", async () => {
    kanban.listInvitations.mockResolvedValue([
      {
        coordinate: "32301:" + "b".repeat(64) + ":board1",
        role: "admin",
        inviter: "c".repeat(64),
        message: "welcome aboard",
        wrapId: "w".repeat(64),
        createdAt: 0,
      },
    ]);
    const res = await register(ctx).get("list_kanban_invitations")!.handler({});
    expect(res.ok).toBe(true);
    expect(res.data.invitations).toHaveLength(1);
    expect(JSON.stringify(res.data)).not.toContain("viewKey");
  });

  it("invite_kanban_member is gated and defaults roles to participant", async () => {
    const refused = await register(ctx)
      .get("invite_kanban_member")!
      .handler({ board: BOARD, invitees: [{ pubkey: "c".repeat(64) }] });
    expect(refused.ok).toBe(false);
    expect(refused.text.startsWith(CONFIRM_REQUIRED_PREFIX)).toBe(true);
    kanban.inviteMembers.mockResolvedValue({ coordinate: BOARD, title: "Sprint" });
    const res = await register(ctx)
      .get("invite_kanban_member")!
      .handler({ board: BOARD, confirm: true, invitees: [{ pubkey: "c".repeat(64) }] });
    expect(res.ok).toBe(true);
    expect(kanban.inviteMembers).toHaveBeenCalledWith(
      BOARD,
      [{ pubkey: "c".repeat(64), role: "participant" }],
      undefined,
    );
  });

  it("accept_kanban_invitation requires confirm, then joins", async () => {
    const refused = await register(ctx).get("accept_kanban_invitation")!.handler({ wrapId: "w1" });
    expect(refused.ok).toBe(false);
    kanban.acceptInvitation.mockResolvedValue({ coordinate: BOARD, title: "Sprint" });
    const res = await register(ctx)
      .get("accept_kanban_invitation")!
      .handler({ wrapId: "w1", confirm: true });
    expect(res.ok).toBe(true);
    expect(kanban.acceptInvitation).toHaveBeenCalledWith("w1", undefined);
  });

  it("accept_kanban_invitation files the board under listId when given", async () => {
    kanban.acceptInvitation.mockResolvedValue({ coordinate: BOARD, title: "Sprint" });
    const res = await register(ctx)
      .get("accept_kanban_invitation")!
      .handler({ wrapId: "w1", listId: "list1", confirm: true });
    expect(kanban.acceptInvitation).toHaveBeenCalledWith("w1", "list1");
    expect(res.ok).toBe(true);
  });

  it("dismiss_kanban_invitation is gated and delegates", async () => {
    const refused = await register(ctx).get("dismiss_kanban_invitation")!.handler({ wrapId: "w1" });
    expect(refused.ok).toBe(false);
    kanban.dismissInvitation.mockResolvedValue(undefined);
    const res = await register(ctx)
      .get("dismiss_kanban_invitation")!
      .handler({ wrapId: "w1", confirm: true });
    expect(res.ok).toBe(true);
    expect(kanban.dismissInvitation).toHaveBeenCalledWith("w1");
  });
});
