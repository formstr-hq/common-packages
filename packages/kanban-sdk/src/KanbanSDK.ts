import {
  SignerRequiredError,
  ViewKeyRequiredError,
  type KanbanCtx,
  type KanbanSigner,
  type NostrRuntime,
} from "./contracts";
import { normalizeRelayList } from "./discovery/relays";
import { KANBAN_KINDS } from "./kinds";
import { SimplePoolRuntime } from "./runtime/pool";
import * as boardLists from "./services/boardLists";
import * as boards from "./services/boards";
import * as cards from "./services/cards";
import type {
  BoardDraft,
  BoardListRef,
  CardDraft,
  KanbanBoard,
  KanbanBoardList,
  KanbanCard,
} from "./types";

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

  /** Private or public — the caller does not branch, the codec does. */
  async createBoard(draft: BoardDraft): Promise<KanbanBoard> {
    if (!draft.private) return boards.createBoard(this.ctx, draft);
    const { board } = await boards.createPrivateBoard(this.ctx, draft);
    return board;
  }

  /** The board list the private board was linked into, alongside the board. */
  createPrivateBoard(draft: BoardDraft): Promise<{ board: KanbanBoard; list: KanbanBoardList }> {
    return boards.createPrivateBoard(this.ctx, { ...draft, private: true });
  }

  updateBoard(board: KanbanBoard, changes: Partial<BoardDraft>): Promise<KanbanBoard> {
    return board.isPrivate
      ? boards.updatePrivateBoard(this.ctx, board, changes)
      : boards.updateBoard(this.ctx, board, changes);
  }

  fetchBoards(params: { authors?: string[]; maintainedBy?: string } = {}): Promise<KanbanBoard[]> {
    return boards.fetchBoards(this.ctx, params);
  }

  fetchPrivateBoards(): Promise<KanbanBoard[]> {
    return boards.fetchPrivateBoards(this.ctx);
  }

  /** A `32301:` coordinate needs its view key; a `30301:` one must not be given one. */
  fetchBoardByCoordinate(coordinate: string, viewKey?: string): Promise<KanbanBoard | null> {
    if (coordinate.startsWith(`${KANBAN_KINDS.privateBoard}:`)) {
      if (!viewKey) throw new ViewKeyRequiredError(coordinate);
      return boards.fetchPrivateBoardByCoordinate(this.ctx, coordinate, viewKey);
    }
    return boards.fetchBoardByCoordinate(this.ctx, coordinate);
  }

  deleteBoard(board: KanbanBoard): Promise<void> {
    return boards.deleteBoard(this.ctx, board);
  }

  createCard(board: KanbanBoard, draft: CardDraft): Promise<KanbanCard> {
    return board.isPrivate
      ? cards.createPrivateCard(this.ctx, board, draft)
      : cards.createCard(this.ctx, board, draft);
  }

  updateCard(
    board: KanbanBoard,
    card: KanbanCard,
    changes: Partial<CardDraft>,
  ): Promise<KanbanCard> {
    return board.isPrivate
      ? cards.updatePrivateCard(this.ctx, board, card, changes)
      : cards.updateCard(this.ctx, board, card, changes);
  }

  moveCard(
    board: KanbanBoard,
    allCards: KanbanCard[],
    cardId: string,
    targetStatus: string,
    targetIndex: number,
  ): Promise<KanbanCard> {
    return board.isPrivate
      ? cards.movePrivateCard(this.ctx, board, allCards, cardId, targetStatus, targetIndex)
      : cards.moveCard(this.ctx, board, allCards, cardId, targetStatus, targetIndex);
  }

  fetchCards(board: KanbanBoard): Promise<KanbanCard[]> {
    return board.isPrivate
      ? cards.fetchPrivateCards(this.ctx, board)
      : cards.fetchCards(this.ctx, board);
  }

  deleteCard(card: KanbanCard): Promise<void> {
    return cards.deleteCard(this.ctx, card);
  }

  createBoardList(title?: string): Promise<KanbanBoardList> {
    return boardLists.createBoardList(this.ctx, title);
  }

  fetchBoardLists(): Promise<KanbanBoardList[]> {
    return boardLists.fetchBoardLists(this.ctx);
  }

  addBoardToList(list: KanbanBoardList, ref: BoardListRef): Promise<KanbanBoardList> {
    return boardLists.addBoardToList(this.ctx, list, ref);
  }

  removeBoardFromList(list: KanbanBoardList, coordinate: string): Promise<KanbanBoardList> {
    return boardLists.removeBoardFromList(this.ctx, list, coordinate);
  }

  lookupBoardViewKey(coordinate: string): Promise<string | undefined> {
    return boardLists.lookupBoardViewKey(this.ctx, coordinate);
  }
}
