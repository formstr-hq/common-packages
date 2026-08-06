import type { BoardMember, KanbanBoard } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

const EMPTY: BoardMember[] = [];

export function useMembers(board: KanbanBoard | null): AsyncData<BoardMember[]> {
  const { sdk, relays } = useApp();

  const load = useCallback(async () => {
    if (!sdk || !board) return EMPTY;
    return sdk.fetchMembers(board);
  }, [sdk, board]);

  return useAsyncData(sdk && board ? load : null, EMPTY, [
    sdk,
    board ? `${board.pubkey}:${board.id}:${board.maintainers.join(",")}:${board.members.join(",")}` : null,
    relays.join(","),
  ]);
}
