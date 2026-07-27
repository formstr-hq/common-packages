import {
  SignerRequiredError,
  type KanbanCtx,
  type KanbanSigner,
  type NostrRuntime,
} from "./contracts";
import { normalizeRelayList } from "./discovery/relays";
import { SimplePoolRuntime } from "./runtime/pool";
import * as boards from "./services/boards";
import * as cards from "./services/cards";
import type { BoardDraft, CardDraft, KanbanBoard, KanbanCard } from "./types";

/** Cross-app default relay set. Keep any override a superset or boards stop syncing. */
export const DEFAULT_RELAYS = [
  "wss://relay.damus.io/",
  "wss://nos.lol/",
  "wss://relay.primal.net/",
];

export interface KanbanSDKOptions {
  /** Without one, reads work and every write throws SignerRequiredError. */
  signer?: KanbanSigner;
  relays?: string[];
  runtime?: NostrRuntime;
}

export class KanbanSDK {
  private readonly ctx: KanbanCtx;
  private readonly ownsRuntime: boolean;

  constructor(options: KanbanSDKOptions = {}) {
    const runtime = options.runtime ?? new SimplePoolRuntime();
    this.ownsRuntime = options.runtime === undefined;
    this.ctx = {
      getSigner: async () => {
        if (!options.signer) throw new SignerRequiredError("This operation");
        return options.signer;
      },
      runtime,
      relays: normalizeRelayList(options.relays ?? DEFAULT_RELAYS),
    };
  }

  get relays(): readonly string[] {
    return this.ctx.relays;
  }

  dispose(): void {
    if (this.ownsRuntime) this.ctx.runtime.dispose?.();
  }

  createBoard(draft: BoardDraft): Promise<KanbanBoard> {
    return boards.createBoard(this.ctx, draft);
  }

  updateBoard(board: KanbanBoard, changes: Partial<BoardDraft>): Promise<KanbanBoard> {
    return boards.updateBoard(this.ctx, board, changes);
  }

  fetchBoards(params: { authors?: string[]; maintainedBy?: string } = {}): Promise<KanbanBoard[]> {
    return boards.fetchBoards(this.ctx, params);
  }

  fetchBoardByCoordinate(coordinate: string): Promise<KanbanBoard | null> {
    return boards.fetchBoardByCoordinate(this.ctx, coordinate);
  }

  createCard(board: KanbanBoard, draft: CardDraft): Promise<KanbanCard> {
    return cards.createCard(this.ctx, board, draft);
  }

  updateCard(
    board: KanbanBoard,
    card: KanbanCard,
    changes: Partial<CardDraft>,
  ): Promise<KanbanCard> {
    return cards.updateCard(this.ctx, board, card, changes);
  }

  moveCard(
    board: KanbanBoard,
    allCards: KanbanCard[],
    cardId: string,
    targetStatus: string,
    targetIndex: number,
  ): Promise<KanbanCard> {
    return cards.moveCard(this.ctx, board, allCards, cardId, targetStatus, targetIndex);
  }

  fetchCards(board: KanbanBoard): Promise<KanbanCard[]> {
    return cards.fetchCards(this.ctx, board);
  }
}
