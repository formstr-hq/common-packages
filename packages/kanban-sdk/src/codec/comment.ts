import type { Event } from "nostr-tools";

import type { CommentDraft, KanbanComment } from "../types";

/**
 * Private card comment (kind 32304) codec — doc 05 §5b.
 *
 * A comment is its own encrypted event rather than a field on the card: putting
 * comments inside the card would republish the whole card on every comment, and
 * two people commenting at once would lose one of each other's writes.
 *
 * It carries the same public shape as a card — `d` plus the board's blinded
 * pointer — so comments arrive on the existing card fetch in one round trip and
 * reuse the card's crypto path unchanged.
 */

export const COMMENT_MANAGED_TAGS = ["d", "a", "e", "content", "p", "reply"] as const;

export function buildCommentTags(
  draft: CommentDraft,
  dTag: string,
  boardCoordinate: string,
  cardId: string,
): string[][] {
  const tags: string[][] = [
    ["d", dTag],
    ["a", boardCoordinate],
    // The card's `d`, never its event id: an id changes on every card edit, so an
    // id reference would detach the comment the first time the card is touched.
    ["e", cardId],
    ["content", draft.content],
  ];

  for (const mention of draft.mentions ?? []) tags.push(["p", mention]);
  if (draft.replyTo) tags.push(["reply", draft.replyTo]);

  return tags;
}

export function parseComment(event: Event, innerTags: string[][]): KanbanComment | null {
  const id = innerTags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;
  if (event.tags.find((t) => t[0] === "d")?.[1] !== id) return null;

  const boardCoordinate = innerTags.find((t) => t[0] === "a")?.[1];
  if (!boardCoordinate) return null;

  const cardId = innerTags.find((t) => t[0] === "e")?.[1];
  if (!cardId) return null;

  // A rotation republishes other people's comments under the rotator's pubkey,
  // exactly as it does for cards (doc 05 §8), so attribution is read the same way.
  const rotatedAuthor = innerTags.find((t) => t[0] === "rotated-author")?.[1];
  // And an edit by another member does the same without a rotation.
  const originalAuthor = innerTags.find((t) => t[0] === "original-author")?.[1];

  return {
    id,
    pubkey: event.pubkey,
    authorPubkey: originalAuthor ?? rotatedAuthor ?? event.pubkey,
    rotated: rotatedAuthor !== undefined,
    eventId: event.id,
    boardCoordinate,
    cardId,
    content: innerTags.find((t) => t[0] === "content")?.[1] ?? "",
    mentions: innerTags.filter((t) => t[0] === "p").map((t) => t[1]),
    replyTo: innerTags.find((t) => t[0] === "reply")?.[1],
    createdAt: event.created_at,
    rawTags: innerTags,
  };
}
