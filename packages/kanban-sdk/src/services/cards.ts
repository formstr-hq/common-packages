import type { Event } from "nostr-tools";

import { boardCoordinate, mergeTags } from "../codec/board";
import { CARD_MANAGED_TAGS, buildPublicCardTags, parsePublicCard } from "../codec/card";
import { computeRank } from "../codec/rank";
import { NotAMaintainerError, type KanbanCtx } from "../contracts";
import { newestByDTag, nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { CardDraft, KanbanBoard, KanbanCard } from "../types";

const coordinateOf = (event: Event): string =>
  `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;

/** NIP-100: the board author plus every `p`-tagged maintainer may write cards. */
export function canEditCards(board: KanbanBoard, pubkey: string): boolean {
  if (!pubkey) return false;
  if (board.pubkey === pubkey) return true;
  return board.maintainers.includes(pubkey);
}

async function assertMaintainer(ctx: KanbanCtx, board: KanbanBoard): Promise<string> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  if (!canEditCards(board, pubkey)) {
    throw new NotAMaintainerError(pubkey, boardCoordinate(board));
  }
  return pubkey;
}

async function publishCard(
  ctx: KanbanCtx,
  tags: string[][],
  createdAt: number,
): Promise<KanbanCard> {
  const signer = await ctx.getSigner();
  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.publicCard,
    created_at: createdAt,
    tags,
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);

  const card = parsePublicCard(signed);
  if (!card) throw new Error("Built an unparseable card event");
  return card;
}

export async function createCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  draft: CardDraft,
): Promise<KanbanCard> {
  await assertMaintainer(ctx, board);

  let rank = draft.rank;
  if (rank === undefined) {
    const existing = await fetchCards(ctx, board);
    const columnRanks = existing
      .filter((c) => c.status === draft.status)
      .map((c) => c.rank)
      .sort((a, b) => a - b);
    rank = computeRank(columnRanks, columnRanks.length);
  }

  const tags = buildPublicCardTags(draft, crypto.randomUUID(), boardCoordinate(board), rank);
  return publishCard(ctx, tags, nextCreatedAt());
}

export async function updateCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  card: KanbanCard,
  changes: Partial<CardDraft>,
): Promise<KanbanCard> {
  await assertMaintainer(ctx, board);

  const draft: CardDraft = {
    title: changes.title ?? card.title,
    description: changes.description ?? card.description,
    status: changes.status ?? card.status,
    attachments: changes.attachments ?? card.attachments,
    assignees: changes.assignees ?? card.assignees,
    labels: changes.labels ?? card.labels,
    links: changes.links ?? card.links,
  };
  const rank = changes.rank ?? card.rank;

  // Merge, never rebuild. This is what stops an edit from stripping a tracker
  // card's k/refs tags — kanbanstr's data-loss bug §6.2.
  const tags = mergeTags(
    card.rawTags,
    buildPublicCardTags(draft, card.id, card.boardCoordinate, rank),
    CARD_MANAGED_TAGS,
  );
  return publishCard(ctx, tags, nextCreatedAt(card.createdAt));
}

export async function moveCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  cards: KanbanCard[],
  cardId: string,
  targetStatus: string,
  targetIndex: number,
): Promise<KanbanCard> {
  const card = cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`Card not found in the supplied list: ${cardId}`);

  const columnRanks = cards
    .filter((c) => c.status === targetStatus && c.id !== cardId)
    .map((c) => c.rank)
    .sort((a, b) => a - b);

  return updateCard(ctx, board, card, {
    status: targetStatus,
    rank: computeRank(columnRanks, targetIndex),
  });
}

export async function fetchCards(ctx: KanbanCtx, board: KanbanBoard): Promise<KanbanCard[]> {
  const coordinate = boardCoordinate(board);
  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.publicCard],
    "#a": [coordinate],
  });
  if (events.length === 0) return [];

  const allowed = new Set([board.pubkey, ...board.maintainers]);
  const authored = events.filter((event) => allowed.has(event.pubkey));

  const deletions = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.deletion],
    authors: [...allowed],
  });
  const deleted = collectDeleted(deletions);

  const live = authored.filter((event) => !isDeleted(event, deleted, coordinateOf));

  const cards: KanbanCard[] = [];
  for (const event of newestByDTag(live).values()) {
    const card = parsePublicCard(event);
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => a.rank - b.rank);
}
