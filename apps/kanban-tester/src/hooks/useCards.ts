import type { KanbanBoard, KanbanCard } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

const EMPTY: KanbanCard[] = [];

export function useCards(board: KanbanBoard | null): AsyncData<KanbanCard[]> {
  const { sdk, relays } = useApp();
  const key = board ? `${board.pubkey}:${board.id}:${board.viewKey ?? ""}` : null;

  const load = useCallback(async () => {
    if (!sdk || !board) return EMPTY;
    const cards = await sdk.fetchCards(board);
    return cards.filter((card) => !card.binned);
  }, [sdk, board]);

  return useAsyncData(sdk && board ? load : null, EMPTY, [sdk, key, relays.join(",")]);
}

/** Cards for one column, in rank order — the order the board renders. */
export function cardsInColumn(cards: KanbanCard[], status: string): KanbanCard[] {
  return cards.filter((card) => card.status === status).sort((a, b) => a.rank - b.rank);
}
