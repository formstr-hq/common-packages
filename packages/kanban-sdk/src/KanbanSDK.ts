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
import * as comments from "./services/comments";
import * as invitations from "./services/invitations";
import * as members from "./services/members";
import type {
  BoardDraft,
  BoardInvitation,
  BoardListRef,
  CardDraft,
  CommentDraft,
  KanbanBoard,
  KanbanBoardList,
  KanbanCard,
  KanbanComment,
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
  /** Invitation gift-wrap wire kind. Defaults to 1059 — see `KanbanCtx.wrapKind`. */
  wrapKind?: number;
  /** `k` discriminator on those wraps. Defaults to 1053 — see `KanbanCtx.wrapType`. */
  wrapType?: number;
  wrapTimestamps?: "jittered" | "real";
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
      wrapKind: options.wrapKind ?? KANBAN_KINDS.inviteGiftWrap,
      wrapType: options.wrapType ?? KANBAN_KINDS.inviteWrapType,
      wrapTimestamps: options.wrapTimestamps,
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

  // ── Sharing (Plan 3) ──────────────────────────────────

  invite(
    board: KanbanBoard,
    invitees: { pubkey: string; role: "maintainer" | "member" }[],
    message?: string,
  ): Promise<KanbanBoard> {
    return members.inviteMembers(this.ctx, board, invitees, message);
  }

  fetchMembers(board: KanbanBoard): Promise<members.BoardMember[]> {
    return members.fetchMembers(this.ctx, board);
  }

  removeMember(board: KanbanBoard, pubkey: string): Promise<KanbanBoard> {
    return members.removeMember(this.ctx, board, pubkey);
  }

  /** Cuts off removed members. O(cards), not atomic, and not retroactive. */
  rotateBoardKey(
    board: KanbanBoard,
    opts: { remove?: string[] } = {},
  ): Promise<members.RotationResult> {
    return members.rotateBoardKey(this.ctx, board, opts);
  }

  fetchInvitations(): Promise<BoardInvitation[]> {
    return invitations.fetchInvitations(this.ctx);
  }

  acceptInvitation(
    invitation: BoardInvitation,
    opts: { listId?: string } = {},
  ): Promise<KanbanBoardList> {
    return invitations.acceptInvitation(this.ctx, invitation, opts);
  }

  dismissInvitation(invitation: BoardInvitation): Promise<void> {
    return invitations.dismissInvitation(this.ctx, invitation);
  }

  createComment(board: KanbanBoard, cardId: string, draft: CommentDraft): Promise<KanbanComment> {
    return comments.createComment(this.ctx, board, cardId, draft);
  }

  updateComment(
    board: KanbanBoard,
    comment: KanbanComment,
    changes: Partial<CommentDraft>,
  ): Promise<KanbanComment> {
    return comments.updateComment(this.ctx, board, comment, changes);
  }

  fetchComments(board: KanbanBoard, cardId?: string): Promise<KanbanComment[]> {
    return comments.fetchComments(this.ctx, board, cardId);
  }

  deleteComment(comment: KanbanComment): Promise<void> {
    return comments.deleteComment(this.ctx, comment);
  }

}
