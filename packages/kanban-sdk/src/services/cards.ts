import type { Event } from "nostr-tools";

import { boardCoordinate, mergeTags, withOriginalAuthor } from "../codec/board";
import {
  CARD_MANAGED_TAGS,
  PRIVATE_CARD_MANAGED_TAGS,
  buildPrivateCardTags,
  buildPublicCardTags,
  parsePrivateCard,
  parsePublicCard,
} from "../codec/card";
import { computeRank } from "../codec/rank";
import { NotAMaintainerError, NotEventAuthorError, type KanbanCtx } from "../contracts";
import { blindedPointer } from "../crypto/blindedPointer";
import { decryptWithViewKey, encryptWithViewKey, viewKeyFromNsec } from "../crypto/viewKey";
import { newestByDTag, nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { CardDraft, KanbanBoard, KanbanCard } from "../types";
import { resolveBoardViewKey } from "./boards";

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
  const editor = await assertMaintainer(ctx, board);

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
  let tags = mergeTags(
    card.rawTags,
    buildPublicCardTags(draft, card.id, card.boardCoordinate, rank),
    CARD_MANAGED_TAGS,
  );
  if (editor !== card.authorPubkey) tags = withOriginalAuthor(tags, card.authorPubkey);
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

// ── Private path (NIP-100E) ─────────────────────────────

/** The `b` tag every card on this board carries. Doc 05 §2. */
export function boardPointer(board: KanbanBoard, viewKeyNsec: string): string {
  return blindedPointer(viewKeyFromNsec(viewKeyNsec).pubkey, boardCoordinate(board));
}

async function publishPrivateCard(
  ctx: KanbanCtx,
  innerTags: string[][],
  pointer: string,
  viewKeyNsec: string,
  createdAt: number,
): Promise<KanbanCard> {
  const signer = await ctx.getSigner();
  const dTag = innerTags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = await encryptWithViewKey(viewKeyNsec, JSON.stringify(innerTags));

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.privateCard,
    created_at: createdAt,
    tags: [
      ["d", dTag],
      ["b", pointer],
    ],
    content,
  });
  await ctx.runtime.publish(ctx.relays, signed);

  const card = parsePrivateCard(signed, innerTags);
  if (!card) throw new Error("Built an unparseable private card event");
  return card;
}

export async function createPrivateCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  draft: CardDraft,
): Promise<KanbanCard> {
  await assertMaintainer(ctx, board);
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);

  let rank = draft.rank;
  if (rank === undefined) {
    const existing = await fetchPrivateCards(ctx, board);
    const columnRanks = existing
      .filter((c) => c.status === draft.status)
      .map((c) => c.rank)
      .sort((a, b) => a - b);
    rank = computeRank(columnRanks, columnRanks.length);
  }

  const inner = buildPrivateCardTags(draft, crypto.randomUUID(), boardCoordinate(board), rank);
  return publishPrivateCard(
    ctx,
    inner,
    boardPointer(board, viewKeyNsec),
    viewKeyNsec,
    nextCreatedAt(),
  );
}

export async function updatePrivateCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  card: KanbanCard,
  changes: Partial<CardDraft>,
): Promise<KanbanCard> {
  const editor = await assertMaintainer(ctx, board);

  // Editing a card against the wrong board loses it entirely: the republish would
  // carry THIS board's blinded pointer but the card's own `a` coordinate, so the
  // supplied board discards it on the §7 step-2 check while the owning board can
  // no longer find it under the new pointer — and the new version has already
  // superseded the old one at that coordinate. Refuse instead.
  if (card.boardCoordinate !== boardCoordinate(board)) {
    throw new Error(
      `Card ${card.id} belongs to ${card.boardCoordinate}, not ${boardCoordinate(board)}`,
    );
  }

  // The board's existing key, never a fresh one: re-keying here would encrypt the
  // card away from every other member of the board.
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);

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

  let inner = mergeTags(
    card.rawTags,
    buildPrivateCardTags(draft, card.id, card.boardCoordinate, rank),
    PRIVATE_CARD_MANAGED_TAGS,
  );
  if (editor !== card.authorPubkey) inner = withOriginalAuthor(inner, card.authorPubkey);

  return publishPrivateCard(
    ctx,
    inner,
    boardPointer(board, viewKeyNsec),
    viewKeyNsec,
    nextCreatedAt(card.createdAt),
  );
}

export async function movePrivateCard(
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

  return updatePrivateCard(ctx, board, card, {
    status: targetStatus,
    rank: computeRank(columnRanks, targetIndex),
  });
}

/**
 * Doc 05 §7, in order:
 *   1. decrypt under the board key — a failure means the writer had no key
 *   2. inner `a` must equal this board's coordinate — blocks cross-posting
 *   3. author must be the board owner or a maintainer — blocks card injection
 *   4. resolve one version per `d` by NIP-01 rules — newest, ties by lowest id
 *
 * One relay-side filter on `b`, one on deletions. No client-side scan of a
 * global kind, and no signer round trip per card.
 */
export async function fetchPrivateCards(
  ctx: KanbanCtx,
  board: KanbanBoard,
): Promise<KanbanCard[]> {
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);
  const coordinate = boardCoordinate(board);

  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.privateCard],
    "#b": [boardPointer(board, viewKeyNsec)],
  });
  if (events.length === 0) return [];

  const allowed = new Set([board.pubkey, ...board.maintainers]);
  const authored = events.filter((event) => allowed.has(event.pubkey));
  if (authored.length === 0) return [];

  const deletions = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.deletion],
    authors: [...allowed],
  });
  const deleted = collectDeleted(deletions);
  const live = authored.filter((event) => !isDeleted(event, deleted, coordinateOf));

  // Decrypt before resolving: the `a` check needs plaintext, and a payload that
  // fails it must not be allowed to win its `d` group and hide the real card.
  const decrypted = new Map<string, string[][]>();
  const usable: Event[] = [];
  for (const event of live) {
    try {
      const payload = JSON.parse(await decryptWithViewKey(viewKeyNsec, event.content)) as unknown;
      if (!Array.isArray(payload)) continue;
      const inner = payload as string[][];
      if (inner.find((t) => t[0] === "a")?.[1] !== coordinate) continue;
      decrypted.set(event.id, inner);
      usable.push(event);
    } catch {
      continue;
    }
  }

  const cards: KanbanCard[] = [];
  for (const event of resolveWithRotation(usable, (e) => decrypted.get(e.id)!).values()) {
    const card = parsePrivateCard(event, decrypted.get(event.id)!);
    if (card) cards.push(card);
  }
  return cards.sort((a, b) => a.rank - b.rank);
}

/**
 * NIP-01 resolution per `d`, with the rotation exception of doc 05 §7 step 4.
 *
 * A rotation republishes other people's cards under the rotator's pubkey, so two
 * coordinates end up sharing a `d`: the real author's, and the rotator's copy
 * carrying `rotated-author`. Resolving those by `created_at` alone hands the card
 * to whoever wrote last, so its displayed authorship flips on every edit. A
 * version signed by the recorded original author therefore wins outright; only
 * when no such version exists does newest-wins decide.
 *
 * Exported because comments resolve by exactly the same rules (doc 05 §5b).
 */
export function resolveWithRotation(
  events: Event[],
  innerOf: (event: Event) => string[][],
): Map<string, Event> {
  const byDTag = new Map<string, Event[]>();
  for (const event of events) {
    const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const bucket = byDTag.get(dTag) ?? [];
    bucket.push(event);
    byDTag.set(dTag, bucket);
  }

  const resolved = new Map<string, Event>();
  for (const [dTag, bucket] of byDTag) {
    const rotatedAuthor = bucket
      .map((event) => innerOf(event).find((t) => t[0] === "rotated-author")?.[1])
      .find((value): value is string => value !== undefined);

    const authored = rotatedAuthor ? bucket.filter((event) => event.pubkey === rotatedAuthor) : [];

    const candidates = authored.length > 0 ? authored : bucket;
    const winner = newestByDTag(candidates).get(dTag);
    if (winner) resolved.set(dTag, winner);
  }
  return resolved;
}

/**
 * Take a card off the board without a tombstone, or put it back.
 *
 * NIP-09 lets only a card's own author delete it, so this is how anyone else
 * with write access removes one. `binned` is an ordinary edit every reader
 * honours, it is reversible, and it survives later edits because neither
 * managed-tag list owns it.
 */
export async function binCard(
  ctx: KanbanCtx,
  board: KanbanBoard,
  card: KanbanCard,
  binned = true,
): Promise<KanbanCard> {
  const editor = await assertMaintainer(ctx, board);

  // Same trap as updatePrivateCard: republishing against the wrong board would
  // carry this board's pointer and the card's own coordinate, losing it from both.
  if (card.boardCoordinate !== boardCoordinate(board)) {
    throw new Error(
      `Card ${card.id} belongs to ${card.boardCoordinate}, not ${boardCoordinate(board)}`,
    );
  }

  let tags = card.rawTags.filter((t) => t[0] !== "binned");
  if (binned) tags = [...tags, ["binned"]];
  if (editor !== card.authorPubkey) tags = withOriginalAuthor(tags, card.authorPubkey);

  if (!card.isPrivate) return publishCard(ctx, tags, nextCreatedAt(card.createdAt));

  const viewKeyNsec = await resolveBoardViewKey(ctx, board);
  return publishPrivateCard(
    ctx,
    tags,
    boardPointer(board, viewKeyNsec),
    viewKeyNsec,
    nextCreatedAt(card.createdAt),
  );
}

/**
 * Retract a card by tombstoning it.
 *
 * The check is against `card.pubkey` — who signed this version — not
 * `authorPubkey`, because that is what NIP-09 binds a deletion to. After a key
 * rotation republished someone else's card, the rotator signs it and so only the
 * rotator can retract it; the original author bins it instead (`binCard`).
 */
export async function deleteCard(ctx: KanbanCtx, card: KanbanCard): Promise<void> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  const kind = card.isPrivate ? KANBAN_KINDS.privateCard : KANBAN_KINDS.publicCard;
  if (card.pubkey !== pubkey) {
    throw new NotEventAuthorError(pubkey, `${kind}:${card.pubkey}:${card.id}`);
  }

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.deletion,
    created_at: nextCreatedAt(),
    tags: [
      ["e", card.eventId],
      ["a", `${kind}:${card.pubkey}:${card.id}`],
      ["k", String(kind)],
    ],
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);
}
