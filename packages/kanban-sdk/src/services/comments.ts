import type { Event } from "nostr-tools";

import { boardCoordinate, mergeTags, withOriginalAuthor } from "../codec/board";
import { COMMENT_MANAGED_TAGS, buildCommentTags, parseComment } from "../codec/comment";
import { NotEventAuthorError, type KanbanCtx } from "../contracts";
import { decryptWithViewKey, encryptWithViewKey } from "../crypto/viewKey";
import { nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted, isDeleted } from "../discovery/deletions";
import { KANBAN_KINDS } from "../kinds";
import type { CommentDraft, KanbanBoard, KanbanComment } from "../types";
import { resolveBoardViewKey } from "./boards";
import { boardPointer, resolveWithRotation } from "./cards";

const coordinateOf = (event: Event): string =>
  `${event.kind}:${event.pubkey}:${event.tags.find((t) => t[0] === "d")?.[1] ?? ""}`;

/**
 * Doc 05 §5b: anyone with the board's key may comment, not only its writers.
 * That includes viewers carried over from the removed Viewer role — commenting
 * was the one thing they could do, and this release does not take it away.
 */
export function canComment(board: KanbanBoard, pubkey: string): boolean {
  if (!pubkey) return false;
  if (board.pubkey === pubkey) return true;
  return (
    board.admins.includes(pubkey) ||
    board.participants.includes(pubkey) ||
    board.legacyViewers.includes(pubkey)
  );
}

async function assertCommenter(ctx: KanbanCtx, board: KanbanBoard): Promise<string> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  if (!canComment(board, pubkey)) {
    throw new Error(`${pubkey} cannot comment on ${boardCoordinate(board)}`);
  }
  return pubkey;
}

async function publishComment(
  ctx: KanbanCtx,
  innerTags: string[][],
  pointer: string,
  viewKeyNsec: string,
  createdAt: number,
): Promise<KanbanComment> {
  const signer = await ctx.getSigner();
  const dTag = innerTags.find((t) => t[0] === "d")?.[1] ?? "";
  const content = await encryptWithViewKey(viewKeyNsec, JSON.stringify(innerTags));

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.privateComment,
    created_at: createdAt,
    tags: [
      ["d", dTag],
      ["b", pointer],
    ],
    content,
  });
  await ctx.runtime.publish(ctx.relays, signed);

  const comment = parseComment(signed, innerTags);
  if (!comment) throw new Error("Built an unparseable comment event");
  return comment;
}

export async function createComment(
  ctx: KanbanCtx,
  board: KanbanBoard,
  cardId: string,
  draft: CommentDraft,
): Promise<KanbanComment> {
  await assertCommenter(ctx, board);
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);

  const inner = buildCommentTags(draft, crypto.randomUUID(), boardCoordinate(board), cardId);
  return publishComment(ctx, inner, boardPointer(board, viewKeyNsec), viewKeyNsec, nextCreatedAt());
}

export async function updateComment(
  ctx: KanbanCtx,
  board: KanbanBoard,
  comment: KanbanComment,
  changes: Partial<CommentDraft>,
): Promise<KanbanComment> {
  const editor = await assertCommenter(ctx, board);
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);

  const draft: CommentDraft = {
    content: changes.content ?? comment.content,
    mentions: changes.mentions ?? comment.mentions,
    replyTo: changes.replyTo ?? comment.replyTo,
  };

  let inner = mergeTags(
    comment.rawTags,
    buildCommentTags(draft, comment.id, comment.boardCoordinate, comment.cardId),
    COMMENT_MANAGED_TAGS,
  );
  if (editor !== comment.authorPubkey) inner = withOriginalAuthor(inner, comment.authorPubkey);

  return publishComment(
    ctx,
    inner,
    boardPointer(board, viewKeyNsec),
    viewKeyNsec,
    nextCreatedAt(comment.createdAt),
  );
}

/**
 * Comments for one card, or for the whole board when `cardId` is omitted. Same
 * §7 pipeline as cards — decrypt, check the inner `a`, check the author, resolve
 * per `d` — except step 3 admits members as well as maintainers.
 */
export async function fetchComments(
  ctx: KanbanCtx,
  board: KanbanBoard,
  cardId?: string,
): Promise<KanbanComment[]> {
  const viewKeyNsec = await resolveBoardViewKey(ctx, board);
  const coordinate = boardCoordinate(board);

  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.privateComment],
    "#b": [boardPointer(board, viewKeyNsec)],
  });
  if (events.length === 0) return [];

  const allowed = new Set([
    board.pubkey,
    ...board.admins,
    ...board.participants,
    ...board.legacyViewers,
  ]);
  const authored = events.filter((event) => allowed.has(event.pubkey));
  if (authored.length === 0) return [];

  const deletions = await ctx.runtime.querySync(ctx.relays, {
    kinds: [KANBAN_KINDS.deletion],
    authors: [...allowed],
  });
  const deleted = collectDeleted(deletions);
  const live = authored.filter((event) => !isDeleted(event, deleted, coordinateOf));

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

  const comments: KanbanComment[] = [];
  // Same resolution as cards, rotation exception included (doc 05 §5b: comments
  // resolve by §7 steps 1-4). Plain newest-wins would let a rotator's copy
  // outrank the author's own version and flip attribution on every edit.
  for (const event of resolveWithRotation(usable, (e) => decrypted.get(e.id)!).values()) {
    const comment = parseComment(event, decrypted.get(event.id)!);
    if (!comment) continue;
    if (cardId && comment.cardId !== cardId) continue;
    comments.push(comment);
  }
  // Oldest first: a comment thread reads in the order it was written.
  return comments.sort((a, b) => a.createdAt - b.createdAt);
}

/** Same NIP-09 rule as `deleteCard`: only the signer of this version can retract it. */
export async function deleteComment(ctx: KanbanCtx, comment: KanbanComment): Promise<void> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  if (comment.pubkey !== pubkey) {
    throw new NotEventAuthorError(
      pubkey,
      `${KANBAN_KINDS.privateComment}:${comment.pubkey}:${comment.id}`,
    );
  }

  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.deletion,
    created_at: nextCreatedAt(),
    tags: [
      ["e", comment.eventId],
      ["a", `${KANBAN_KINDS.privateComment}:${comment.pubkey}:${comment.id}`],
      ["k", String(KANBAN_KINDS.privateComment)],
    ],
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);
}
