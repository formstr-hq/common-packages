import type { KanbanBoard, KanbanComment } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

const EMPTY: KanbanComment[] = [];

export function useComments(
  board: KanbanBoard | null,
  cardId: string | null,
): AsyncData<KanbanComment[]> {
  const { sdk, relays } = useApp();

  const load = useCallback(async () => {
    if (!sdk || !board || !cardId) return EMPTY;
    const comments = await sdk.fetchComments(board, cardId);
    return [...comments].sort((a, b) => a.createdAt - b.createdAt);
  }, [sdk, board, cardId]);

  return useAsyncData(sdk && board && cardId ? load : null, EMPTY, [
    sdk,
    board ? `${board.pubkey}:${board.id}` : null,
    cardId,
    relays.join(","),
  ]);
}

export interface CommentNode {
  comment: KanbanComment;
  replies: KanbanComment[];
}

/** The protocol allows exactly one level of threading, so this is not recursive. */
export function threadComments(comments: KanbanComment[]): CommentNode[] {
  const roots = comments.filter((c) => !c.replyTo);
  const byParent = new Map<string, KanbanComment[]>();
  for (const comment of comments) {
    if (!comment.replyTo) continue;
    const bucket = byParent.get(comment.replyTo) ?? [];
    bucket.push(comment);
    byParent.set(comment.replyTo, bucket);
  }
  return roots.map((comment) => ({ comment, replies: byParent.get(comment.id) ?? [] }));
}
