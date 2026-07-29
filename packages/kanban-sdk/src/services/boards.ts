import type { Event, Filter } from "nostr-tools";

import {
  BOARD_MANAGED_TAGS,
  PRIVATE_BOARD_MANAGED_TAGS,
  boardCoordinate,
  buildPrivateBoardTags,
  buildPublicBoardTags,
  mergeTags,
  parsePrivateBoard,
  parsePublicBoard,
} from "../codec/board";
import {
  BoardNotFoundError,
  NotBoardOwnerError,
  ViewKeyRequiredError,
  type KanbanCtx,
} from "../contracts";
import {
  decryptWithViewKey,
  encryptWithViewKey,
  generateViewKey,
  viewKeyFromNsec,
} from "../crypto/viewKey";
import { newestByDTag, nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { BoardDraft, KanbanBoard, KanbanBoardList } from "../types";
import { addBoardToList, ensureBoardList, fetchBoardLists, lookupBoardViewKey } from "./boardLists";

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

// ── Private path (NIP-100E) ─────────────────────────────

/**
 * The view key for a board: the one it was loaded with, else the one stored in
 * the user's own board lists. Anything else is unreadable — there is no third
 * place a key can come from.
 */
export async function resolveBoardViewKey(ctx: KanbanCtx, board: KanbanBoard): Promise<string> {
  if (board.viewKey) return board.viewKey;
  const coordinate = boardCoordinate(board);
  const stored = await lookupBoardViewKey(ctx, coordinate);
  if (!stored) throw new ViewKeyRequiredError(coordinate);
  return stored;
}

async function publishPrivateBoard(
  ctx: KanbanCtx,
  innerTags: string[][],
  dTag: string,
  viewKeyNsec: string,
  createdAt: number,
): Promise<KanbanBoard> {
  const signer = await ctx.getSigner();
  const content = await encryptWithViewKey(viewKeyNsec, JSON.stringify(innerTags));

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.privateBoard,
    created_at: createdAt,
    // Only `d` is public. No `alt` — see doc 05 §3.
    tags: [["d", dTag]],
    content,
  });
  await ctx.runtime.publish(ctx.relays, signed);

  const board = parsePrivateBoard(signed, innerTags);
  if (!board) throw new Error("Built an unparseable private board event");
  board.viewKey = viewKeyNsec;
  return board;
}

export async function createPrivateBoard(
  ctx: KanbanCtx,
  draft: BoardDraft,
): Promise<{ board: KanbanBoard; list: KanbanBoardList }> {
  const viewKey = draft.viewKey ? viewKeyFromNsec(draft.viewKey) : generateViewKey();
  // Random, never derived: a `d` tag is public and permanent, and a derived one
  // would let an observer confirm a guessed title by brute-forcing created_at.
  const dTag = crypto.randomUUID();
  const inner = buildPrivateBoardTags(draft, dTag);

  const board = await publishPrivateBoard(ctx, inner, dTag, viewKey.nsec, nextCreatedAt());
  board.relayHint = ctx.relays[0] ?? "";

  // Unconditional, even when draft.listId failed to resolve: an unlisted private
  // board's view key exists only in this return value, and the board becomes
  // unrecoverable the moment the caller drops it.
  const list = await ensureBoardList(ctx, draft.listId);
  const linked = await addBoardToList(ctx, list, {
    coordinate: boardCoordinate(board),
    relayHint: board.relayHint,
    viewKey: viewKey.nsec,
    role: "owner",
  });

  return { board, list: linked };
}

export async function updatePrivateBoard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  changes: Partial<BoardDraft>,
): Promise<KanbanBoard> {
  const signer = await ctx.getSigner();
  const author = await signer.getPublicKey();
  // A board is an addressable event owned by one pubkey: a maintainer's "edit"
  // would publish a second coordinate, not a new version (doc 05 §7).
  if (author !== board.pubkey) throw new NotBoardOwnerError(author, boardCoordinate(board));

  const viewKeyNsec = await resolveBoardViewKey(ctx, board);

  const draft: BoardDraft = {
    title: changes.title ?? board.title,
    description: changes.description ?? board.description,
    columns: changes.columns ?? board.columns,
    maintainers: changes.maintainers ?? board.maintainers,
    members: changes.members ?? board.members,
    noZap: changes.noZap ?? board.noZap,
  };

  // Merge into the DECRYPTED tags of the fetched event, never rebuild.
  const inner = mergeTags(
    board.rawTags,
    buildPrivateBoardTags(draft, board.id),
    PRIVATE_BOARD_MANAGED_TAGS,
  );

  const updated = await publishPrivateBoard(
    ctx,
    inner,
    board.id,
    viewKeyNsec,
    nextCreatedAt(board.createdAt),
  );
  updated.relayHint = board.relayHint;
  return updated;
}

export async function fetchPrivateBoardByCoordinate(
  ctx: KanbanCtx,
  coordinate: string,
  viewKeyNsec: string,
): Promise<KanbanBoard | null> {
  const [kind, pubkey, dTag] = coordinate.split(":");
  if (Number.parseInt(kind, 10) !== KANBAN_KINDS.privateBoard || !pubkey || !dTag) {
    throw new BoardNotFoundError(coordinate);
  }

  const [events, deletions] = await Promise.all([
    ctx.runtime.querySync(ctx.relays, {
      kinds: [KANBAN_KINDS.privateBoard],
      authors: [pubkey],
      "#d": [dTag],
    }),
    ctx.runtime.querySync(ctx.relays, { kinds: [KANBAN_KINDS.deletion], authors: [pubkey] }),
  ]);

  const deleted = collectDeleted(deletions);
  const live = events.filter((event) => !isDeleted(event, deleted, coordinateOf));
  const current = newestByDTag(live).get(dTag);
  if (!current) return null;

  try {
    const payload = JSON.parse(await decryptWithViewKey(viewKeyNsec, current.content)) as unknown;
    if (!Array.isArray(payload)) return null;
    const board = parsePrivateBoard(current, payload as string[][]);
    if (!board) return null;
    board.viewKey = viewKeyNsec;
    return board;
  } catch {
    // Wrong key, or not a board payload at all. A caller holding the wrong key is
    // an ordinary state, not an exception.
    return null;
  }
}

/** Every private board the user can reach, resolved through their board lists. */
export async function fetchPrivateBoards(ctx: KanbanCtx): Promise<KanbanBoard[]> {
  const lists = await fetchBoardLists(ctx);
  const seen = new Set<string>();
  const boards: KanbanBoard[] = [];

  for (const list of lists) {
    for (const ref of list.boards) {
      if (!ref.viewKey || seen.has(ref.coordinate)) continue;
      seen.add(ref.coordinate);
      const board = await fetchPrivateBoardByCoordinate(ctx, ref.coordinate, ref.viewKey);
      if (!board) continue;
      board.relayHint = ref.relayHint;
      boards.push(board);
    }
  }
  return boards;
}

export { boardCoordinate };
