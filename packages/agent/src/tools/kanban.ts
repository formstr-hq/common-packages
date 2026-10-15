import { z } from "zod";

import type { CardDraft, KanbanBoard } from "@formstr/kanban-sdk";

import { ok, fail, table } from "../result";
import { requireConfirm } from "../safety";
import { kanban } from "../services";

import type { ToolDef } from "./types";

async function loadBoard(coordinate: string): Promise<KanbanBoard | null> {
  return kanban.resolveBoard(coordinate);
}

export const kanbanTools: ToolDef[] = buildKanbanTools();

function buildKanbanTools(): ToolDef[] {
  const tools: ToolDef[] = [];
  let write = false;
  const server = {
    registerTool(
      name: string,
      config: Pick<ToolDef, "description" | "inputSchema">,
      handler: ToolDef["handler"],
    ) {
      tools.push({ name, ...config, handler, ...(write ? { write: true } : {}) });
    },
  };

  // ── Read ──────────────────────────────────────────────
  server.registerTool(
    "list_kanban_boards",
    {
      description:
        "List the kanban boards you own, administer, or hold a key for. Returns each board's " +
        "coordinate and columns.",
      inputSchema: {},
    },
    async () => {
      const boards = (await kanban.fetchMyBoards(await kanban.myPubkey())).map(
        kanban.summarizeBoard,
      );
      return ok(
        boards.length
          ? `${boards.length} board(s):\n\n${table(
              boards.map((b) => ({
                board: b.coordinate,
                title: b.title,
                columns: b.columns.join(", "),
                private: b.isPrivate ? "yes" : "no",
              })),
              ["board", "title", "columns", "private"],
            )}`
          : "You have no kanban boards yet. Create one with `create_kanban_board`.",
        { boards },
      );
    },
  );

  server.registerTool(
    "list_kanban_cards",
    {
      description: "List the cards on a kanban board (by its coordinate), newest first.",
      inputSchema: { board: z.string().describe("board coordinate, kind:pubkey:d") },
    },
    async ({ board: coordinate }: { board: string }) => {
      const board = await loadBoard(coordinate);
      if (!board) return fail(`No kanban board at ${coordinate}.`, "NOT_FOUND");
      const cards = (await kanban.listCards(board)).filter((c) => !c.binned).map(kanban.summarizeCard);
      return ok(
        cards.length
          ? `${cards.length} card(s):\n\n${table(
              cards.map((c) => ({
                id: c.id,
                title: c.title,
                status: c.status ?? "",
                assignees: c.assignees.join(", "),
              })),
              ["id", "title", "status", "assignees"],
            )}`
          : "This board has no cards yet.",
        { cards },
      );
    },
  );

  server.registerTool(
    "list_my_kanban_cards",
    {
      description:
        "List kanban cards assigned to you (or to `assignee`) across every board you can read. " +
        "This is how an agent finds work picked up for it.",
      inputSchema: {
        assignee: z
          .string()
          .optional()
          .describe("pubkey to look for; defaults to your own identity"),
      },
    },
    async ({ assignee }: { assignee?: string }) => {
      const pubkey = assignee ?? (await kanban.myPubkey());
      const cards = await kanban.listAssignments(pubkey);
      return ok(
        cards.length
          ? `${cards.length} card(s) assigned:\n\n${table(
              cards.map((c) => ({ id: c.id, title: c.title, board: c.board, status: c.status ?? "" })),
              ["id", "title", "board", "status"],
            )}`
          : "No cards are currently assigned to you.",
        { cards, assignee: pubkey },
      );
    },
  );

  server.registerTool(
    "list_kanban_inbox",
    {
      description:
        "List cards assigned to you that are still in their board's first column — work not yet " +
        "picked up. This is the queue an agent watches to find new assignments. Pass `board` to " +
        "scope it to one board (faster than sweeping every board).",
      inputSchema: {
        board: z.string().optional().describe("board coordinate to scope to; omit for all boards"),
      },
    },
    async ({ board }: { board?: string }) => {
      const pubkey = await kanban.myPubkey();
      const cards = await kanban.openAssignments(pubkey, board);
      return ok(
        cards.length
          ? `${cards.length} open assignment(s):\n\n${table(
              cards.map((c) => ({ id: c.id, title: c.title, board: c.board, status: c.status ?? "" })),
              ["id", "title", "board", "status"],
            )}`
          : "Your inbox is empty — no un-started cards are assigned to you.",
        { cards, assignee: pubkey },
      );
    },
  );

  // ── Constructive ──────────────────────────────────────
  server.registerTool(
    "create_kanban_board",
    {
      description:
        "Create a kanban board. Omit `columns` for the default To Do / In Progress / Done. " +
        "Set `private: true` for an encrypted board.",
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        columns: z.array(z.string()).optional().describe("column names, left to right"),
        private: z.boolean().optional(),
      },
    },
    async ({
      title,
      description,
      columns,
      private: isPrivate,
    }: {
      title: string;
      description?: string;
      columns?: string[];
      private?: boolean;
    }) => {
      const board = await kanban.createBoard({
        title,
        description,
        columns: columns?.length ? kanban.columnsFromNames(columns) : kanban.DEFAULT_COLUMNS,
        private: isPrivate,
      });
      const summary = kanban.summarizeBoard(board);
      return ok(`Created board "${board.title}" with columns ${summary.columns.join(", ")}.`, {
        board: summary,
        coordinate: summary.coordinate,
      });
    },
  );

  server.registerTool(
    "create_kanban_card",
    {
      description:
        "Create a card on a kanban board. `status` is a column name (or id); it defaults to the " +
        "first column. `assignees` are hex pubkeys — assign the agent to make it pick the card up.",
      inputSchema: {
        board: z.string().describe("board coordinate, kind:pubkey:d"),
        title: z.string(),
        description: z.string().optional(),
        status: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
      },
    },
    async (args: {
      board: string;
      title: string;
      description?: string;
      status?: string;
      assignees?: string[];
      labels?: string[];
    }) => {
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      const card = await kanban.createCard(board, kanban.cardDraft(board, args));
      return ok(`Created card "${card.title}" (${card.id}).`, {
        card: kanban.summarizeCard(card),
        id: card.id,
      });
    },
  );

  // ── Gated (destructive / state-changing) ──────────────
  write = true;

  server.registerTool(
    "claim_kanban_card",
    {
      description:
        "Pick up a card assigned to you by moving it one column forward (out of the first " +
        "column). Idempotent: claiming a card that already moved returns claimed:false. " +
        "Requires confirm:true.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        toStatus: z
          .string()
          .optional()
          .describe("column to move it into; defaults to the next column"),
        confirm: z.boolean().optional(),
      },
    },
    async (args: {
      board: string;
      cardId: string;
      toStatus?: string;
      confirm?: boolean;
    }) => {
      const blocked = requireConfirm("claim_kanban_card", args, `claims card ${args.cardId}`);
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      const card = await kanban.findCard(board, args.cardId);
      if (!card) return fail(`No card ${args.cardId} on this board.`, "NOT_FOUND");
      if (!card.assignees.includes(await kanban.myPubkey())) {
        return fail(`Card ${args.cardId} is not assigned to you.`, "NOT_ASSIGNED");
      }
      const { card: claimedCard, claimed } = await kanban.claimCard(board, card, args.toStatus);
      const summary = kanban.summarizeCard(claimedCard);
      return ok(
        claimed
          ? `Claimed card ${claimedCard.id} → "${claimedCard.status}".`
          : `Card ${claimedCard.id} was already picked up (in "${claimedCard.status}").`,
        { card: summary, claimed },
      );
    },
  );

  server.registerTool(
    "update_kanban_card",
    {
      description:
        "Update a card's title, description, assignees, or labels. Requires confirm:true.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        assignees: z.array(z.string()).optional(),
        labels: z.array(z.string()).optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: {
      board: string;
      cardId: string;
      title?: string;
      description?: string;
      assignees?: string[];
      labels?: string[];
      confirm?: boolean;
    }) => {
      const blocked = requireConfirm("update_kanban_card", args, `updates card ${args.cardId}`);
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      const card = await kanban.findCard(board, args.cardId);
      if (!card) return fail(`No card ${args.cardId} on this board.`, "NOT_FOUND");
      const changes: Partial<CardDraft> = {};
      if (args.title !== undefined) changes.title = args.title;
      if (args.description !== undefined) changes.description = args.description;
      if (args.assignees !== undefined) changes.assignees = args.assignees;
      if (args.labels !== undefined) changes.labels = args.labels;
      const updated = await kanban.updateCard(board, card, changes);
      return ok(`Updated card ${updated.id}.`, { card: kanban.summarizeCard(updated) });
    },
  );

  server.registerTool(
    "move_kanban_card",
    {
      description:
        "Move a card to another column. `status` is a column name (or id). Requires confirm:true.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        status: z.string(),
        index: z.number().int().nonnegative().optional(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: {
      board: string;
      cardId: string;
      status: string;
      index?: number;
      confirm?: boolean;
    }) => {
      const blocked = requireConfirm(
        "move_kanban_card",
        args,
        `moves card ${args.cardId} to "${args.status}"`,
      );
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      const column = kanban.columnFor(board, args.status);
      if (!column) {
        return fail(
          `No column "${args.status}" on this board. Columns: ${board.columns.map((c) => c.name).join(", ")}.`,
          "BAD_INPUT",
        );
      }
      const card = await kanban.findCard(board, args.cardId);
      if (!card) return fail(`No card ${args.cardId} on this board.`, "NOT_FOUND");
      const moved = await kanban.moveCard(
        board,
        args.cardId,
        kanban.statusFor(board, column),
        args.index,
      );
      return ok(`Moved card ${moved.id} to "${column.name}".`, {
        card: kanban.summarizeCard(moved),
      });
    },
  );

  server.registerTool(
    "add_kanban_comment",
    {
      description: "Comment on a card. Use this to report what the agent did. Requires confirm:true.",
      inputSchema: {
        board: z.string(),
        cardId: z.string(),
        content: z.string(),
        confirm: z.boolean().optional(),
      },
    },
    async (args: { board: string; cardId: string; content: string; confirm?: boolean }) => {
      const blocked = requireConfirm("add_kanban_comment", args, `comments on card ${args.cardId}`);
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      if (!board.isPrivate) {
        return fail(
          "Comments are currently supported on private boards only — the bundled Kanban SDK's " +
            "comment codec always uses the private kind (32304) and needs the board view key. " +
            "Use `update_kanban_card` to annotate a public card instead.",
          "BAD_INPUT",
        );
      }
      const comment = await kanban.addComment(board, args.cardId, args.content);
      return ok(`Commented on card ${args.cardId}.`, { commentId: comment.id });
    },
  );

  server.registerTool(
    "delete_kanban_card",
    {
      description: "Delete a card you authored. Requires confirm:true.",
      inputSchema: { board: z.string(), cardId: z.string(), confirm: z.boolean().optional() },
    },
    async (args: { board: string; cardId: string; confirm?: boolean }) => {
      const blocked = requireConfirm("delete_kanban_card", args, `deletes card ${args.cardId}`);
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      const card = await kanban.findCard(board, args.cardId);
      if (!card) return fail(`No card ${args.cardId} on this board.`, "NOT_FOUND");
      await kanban.deleteCard(card);
      return ok(`Deleted card ${args.cardId}.`);
    },
  );

  server.registerTool(
    "delete_kanban_board",
    {
      description: "Delete a board you own. Requires confirm:true.",
      inputSchema: { board: z.string(), confirm: z.boolean().optional() },
    },
    async (args: { board: string; confirm?: boolean }) => {
      const blocked = requireConfirm("delete_kanban_board", args, `deletes board ${args.board}`);
      if (blocked) return blocked;
      const board = await loadBoard(args.board);
      if (!board) return fail(`No kanban board at ${args.board}.`, "NOT_FOUND");
      await kanban.deleteBoard(board);
      return ok(`Deleted board ${args.board}.`);
    },
  );

  return tools;
}
