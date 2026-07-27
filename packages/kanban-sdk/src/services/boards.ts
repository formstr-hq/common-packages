import type { Event, Filter } from "nostr-tools";

import {
  BOARD_MANAGED_TAGS,
  boardCoordinate,
  buildPublicBoardTags,
  mergeTags,
  parsePublicBoard,
} from "../codec/board";
import { BoardNotFoundError, type KanbanCtx } from "../contracts";
import { newestByDTag, nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { BoardDraft, KanbanBoard } from "../types";

const coordinateOf = (event: Event): string =>
  `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;

async function publishBoard(
  ctx: KanbanCtx,
  tags: string[][],
  createdAt: number,
): Promise<KanbanBoard> {
  const signer = await ctx.getSigner();
  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.publicBoard,
    created_at: createdAt,
    tags,
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);

  const board = parsePublicBoard(signed);
  if (!board) throw new Error("Built an unparseable board event");
  return board;
}

export async function createBoard(ctx: KanbanCtx, draft: BoardDraft): Promise<KanbanBoard> {
  const dTag = crypto.randomUUID();
  return publishBoard(ctx, buildPublicBoardTags(draft, dTag), nextCreatedAt());
}

export async function updateBoard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  changes: Partial<BoardDraft>,
): Promise<KanbanBoard> {
  const draft: BoardDraft = {
    title: changes.title ?? board.title,
    description: changes.description ?? board.description,
    columns: changes.columns ?? board.columns,
    maintainers: changes.maintainers ?? board.maintainers,
    noZap: changes.noZap ?? board.noZap,
  };

  // Merge, never rebuild: unknown tags written by other clients must survive.
  const tags = mergeTags(board.rawTags, buildPublicBoardTags(draft, board.id), BOARD_MANAGED_TAGS);
  return publishBoard(ctx, tags, nextCreatedAt(board.createdAt));
}

async function resolveBoards(ctx: KanbanCtx, filter: Filter): Promise<KanbanBoard[]> {
  const events = await ctx.runtime.querySync(ctx.relays, filter);
  if (events.length === 0) return [];

  const deletions = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.deletion],
    authors: [...new Set(events.map((e) => e.pubkey))],
  });
  const deleted = collectDeleted(deletions);

  // Group by author too: `d` alone is not unique across authors.
  const byAuthor = new Map<string, Event[]>();
  for (const event of events) {
    if (isDeleted(event, deleted, coordinateOf)) continue;
    const bucket = byAuthor.get(event.pubkey) ?? [];
    bucket.push(event);
    byAuthor.set(event.pubkey, bucket);
  }

  const boards: KanbanBoard[] = [];
  for (const bucket of byAuthor.values()) {
    for (const event of newestByDTag(bucket).values()) {
      const board = parsePublicBoard(event);
      if (board) boards.push(board);
    }
  }
  return boards;
}

export async function fetchBoards(
  ctx: KanbanCtx,
  params: { authors?: string[]; maintainedBy?: string } = {},
): Promise<KanbanBoard[]> {
  const filter: Filter = { kinds: [KANBAN_KINDS.publicBoard] };
  if (params.authors) filter.authors = params.authors;
  if (params.maintainedBy) filter["#p"] = [params.maintainedBy];
  return resolveBoards(ctx, filter);
}

export async function fetchBoardByCoordinate(
  ctx: KanbanCtx,
  coordinate: string,
): Promise<KanbanBoard | null> {
  const [kind, pubkey, dTag] = coordinate.split(":");
  if (Number.parseInt(kind, 10) !== KANBAN_KINDS.publicBoard || !pubkey || !dTag) {
    throw new BoardNotFoundError(coordinate);
  }
  const boards = await resolveBoards(ctx, {
    kinds: [KANBAN_KINDS.publicBoard],
    authors: [pubkey],
    "#d": [dTag],
  });
  return boards[0] ?? null;
}

export { boardCoordinate };
