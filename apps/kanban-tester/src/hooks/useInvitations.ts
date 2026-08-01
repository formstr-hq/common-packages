import type { BoardInvitation } from "@formstr/kanban-sdk";
import { useCallback } from "react";

import { useApp } from "../nostr/AppContext";
import { useAsyncData, type AsyncData } from "./useAsyncData";

const EMPTY: BoardInvitation[] = [];

/**
 * Gift-wrapped board keys addressed to this pubkey. Each one costs a signer
 * round trip to unwrap, so this is a deliberate action, not a poll.
 */
export function useInvitations(): AsyncData<BoardInvitation[]> {
  const { sdk, account, relays } = useApp();

  const load = useCallback(async () => {
    if (!sdk) return EMPTY;
    const invitations = await sdk.fetchInvitations();
    return [...invitations].sort((a, b) => b.createdAt - a.createdAt);
  }, [sdk]);

  return useAsyncData(sdk ? load : null, EMPTY, [sdk, account?.pubkey, relays.join(",")]);
}
