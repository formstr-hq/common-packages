import type { Event } from "nostr-tools";

import {
  DEFAULT_BOARD_LIST_TITLE,
  boardListDTag,
  decodeBoardList,
  encodeBoardList,
} from "../codec/boardList";
import type { KanbanCtx } from "../contracts";
import { nip44SelfDecrypt, nip44SelfEncrypt } from "../crypto/nip44";
import { newestByDTag, nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { BoardListRef, KanbanBoardList } from "../types";

const coordinateOf = (event: Event): string =>
  `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;

async function publishBoardList(
  ctx: KanbanCtx,
  list: KanbanBoardList,
  createdAt: number,
): Promise<KanbanBoardList> {
  const signer = await ctx.getSigner();
  const content = await nip44SelfEncrypt(signer, JSON.stringify(encodeBoardList(list)));

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.boardList,
    created_at: createdAt,
    tags: [["d", list.id]],
    content,
  });
  await ctx.runtime.publish(ctx.relays, signed);

  return { ...list, eventId: signed.id, createdAt };
}

export async function createBoardList(
  ctx: KanbanCtx,
  title: string = DEFAULT_BOARD_LIST_TITLE,
): Promise<KanbanBoardList> {
  const createdAt = nextCreatedAt();
  const list: KanbanBoardList = {
    id: boardListDTag(title, createdAt),
    eventId: "",
    title,
    boards: [],
    createdAt,
  };
  return publishBoardList(ctx, list, createdAt);
}

/**
 * Republish a list. `created_at` strictly supersedes the version the list was
 * loaded from: the create-list → link-board sequence writes twice inside one
 * second, and a tie there resolves by lowest event id — which can resurrect the
 * empty list and lose the view key that was just stored in it.
 */
export async function updateBoardList(
  ctx: KanbanCtx,
  list: KanbanBoardList,
): Promise<KanbanBoardList> {
  return publishBoardList(ctx, list, nextCreatedAt(list.createdAt));
}

export async function fetchBoardLists(ctx: KanbanCtx): Promise<KanbanBoardList[]> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();

  const [events, deletions] = await Promise.all([
    ctx.runtime.querySync(ctx.relays, { kinds: [KANBAN_KINDS.boardList], authors: [pubkey] }),
    ctx.runtime.querySync(ctx.relays, { kinds: [KANBAN_KINDS.deletion], authors: [pubkey] }),
  ]);
  const deleted = collectDeleted(deletions);

  const lists: KanbanBoardList[] = [];
  for (const [dTag, event] of newestByDTag(events)) {
    if (isDeleted(event, deleted, coordinateOf)) continue;
    try {
      const payload = JSON.parse(await nip44SelfDecrypt(signer, event.content)) as unknown;
      if (!Array.isArray(payload)) continue;
      const list = decodeBoardList(payload as string[][], dTag, event.id);
      // Hydrate from the wire event so a later update's monotonic bump supersedes
      // THIS version rather than epoch 0.
      list.createdAt = event.created_at;
      lists.push(list);
    } catch {
      // A list we cannot decrypt is not ours (or is corrupt). Skipping is correct;
      // throwing would let one bad event hide every other board the user has.
      continue;
    }
  }
  return lists;
}

/**
 * Link a board into a list, deduplicating by coordinate.
 *  - already present with the same (or no incoming) view key → no-op, no republish
 *  - already present with a DIFFERENT non-empty view key → replace and republish
 *
 * The second case matters: a ref is the only durable home of a view key, so after
 * a re-key a stale ref leaves the board permanently undecryptable. An incoming
 * empty key never clobbers a stored one.
 */
export async function addBoardToList(
  ctx: KanbanCtx,
  list: KanbanBoardList,
  ref: BoardListRef,
): Promise<KanbanBoardList> {
  const existing = list.boards.find((b) => b.coordinate === ref.coordinate);
  if (existing) {
    if (!ref.viewKey || ref.viewKey === existing.viewKey) return list;
    return updateBoardList(ctx, {
      ...list,
      boards: list.boards.map((b) => (b.coordinate === ref.coordinate ? ref : b)),
    });
  }
  return updateBoardList(ctx, { ...list, boards: [...list.boards, ref] });
}

export async function removeBoardFromList(
  ctx: KanbanCtx,
  list: KanbanBoardList,
  coordinate: string,
): Promise<KanbanBoardList> {
  return updateBoardList(ctx, {
    ...list,
    boards: list.boards.filter((b) => b.coordinate !== coordinate),
  });
}

export async function lookupBoardViewKey(
  ctx: KanbanCtx,
  coordinate: string,
): Promise<string | undefined> {
  for (const list of await fetchBoardLists(ctx)) {
    for (const ref of list.boards) {
      if (ref.coordinate === coordinate && ref.viewKey) return ref.viewKey;
    }
  }
  return undefined;
}

/**
 * Resolve the list a private board should land in: the named one, else the first
 * existing one, else a fresh "My Boards". Never returns undefined — an unlisted
 * private board loses its view key the moment the caller drops the return value.
 */
export async function ensureBoardList(
  ctx: KanbanCtx,
  listId?: string,
): Promise<KanbanBoardList> {
  const lists = await fetchBoardLists(ctx);
  if (listId) {
    const named = lists.find((l) => l.id === listId);
    if (named) return named;
  }
  return lists[0] ?? (await createBoardList(ctx));
}
