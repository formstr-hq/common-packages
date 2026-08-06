import type { KanbanBoard } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export interface BoardsData {
  own: KanbanBoard[];
  shared: KanbanBoard[];
  privateBoards: KanbanBoard[];
}

const EMPTY: BoardsData = { own: [], shared: [], privateBoards: [] };

/**
 * Three separate reads because they are three different questions:
 * boards I authored, public boards that name me a maintainer, and private
 * boards recoverable through my board lists (which is where the view keys are).
 */
export function useBoards(): AsyncData<BoardsData> {
  const { sdk, account, relays } = useApp();
  const pubkey = account?.pubkey;

  const load = useCallback(async (): Promise<BoardsData> => {
    if (!sdk || !pubkey) return EMPTY;
    const [own, maintained, privateBoards] = await Promise.all([
      sdk.fetchBoards({ authors: [pubkey] }),
      sdk.fetchBoards({ maintainedBy: pubkey }),
      sdk.fetchPrivateBoards(),
    ]);
    const ownIds = new Set(own.map((b) => `${b.pubkey}:${b.id}`));
    return {
      own,
      shared: maintained.filter((b) => !ownIds.has(`${b.pubkey}:${b.id}`)),
      privateBoards,
    };
  }, [sdk, pubkey]);

  return useAsyncData(sdk && pubkey ? load : null, EMPTY, [sdk, pubkey, relays.join(",")]);
}
