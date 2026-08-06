import { KANBAN_KINDS, type KanbanBoard } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/**
 * Resolves a board from its coordinate alone, so a deep link survives a reload.
 * A private coordinate needs its view key, which lives in the user's board
 * lists — `lookupBoardViewKey` is that recovery path.
 */
export function useBoard(coordinate: string | null): AsyncData<KanbanBoard | null> {
  const { sdk, relays } = useApp();

  const load = useCallback(async (): Promise<KanbanBoard | null> => {
    if (!sdk || !coordinate) return null;
    if (!coordinate.startsWith(`${KANBAN_KINDS.privateBoard}:`)) {
      return sdk.fetchBoardByCoordinate(coordinate);
    }
    const viewKey = await sdk.lookupBoardViewKey(coordinate);
    // Let the SDK throw ViewKeyRequiredError rather than inventing a message —
    // the error already explains the two ways to get a key.
    return sdk.fetchBoardByCoordinate(coordinate, viewKey);
  }, [sdk, coordinate]);

  return useAsyncData(sdk && coordinate ? load : null, null, [sdk, coordinate, relays.join(",")]);
}
