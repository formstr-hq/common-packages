export interface Column {
  id: string;
  name: string;
  order: number;
}

export interface CardLink {
  boardPubkey: string;
  boardDTag: string;
  cardDTag: string;
  forwardLabel: string;
  reverseLabel: string;
}

export interface TrackedRef {
  eventId?: string;
  boardCoordinate?: string;
  cardDTag?: string;
}

export interface KanbanBoard {
  /** The `d` tag. Board identity is `kind:pubkey:id`. */
  id: string;
  pubkey: string;
  eventId: string;
  title: string;
  description: string;
  columns: Column[];
  maintainers: string[];
  /** Private boards only: view-key holders who are read-only by client convention. */
  members: string[];
  noZap: boolean;
  createdAt: number;
  isPrivate: boolean;
  /** True for v0 boards: columns in JSON content, cards listed by board `a` tags. */
  legacy: boolean;
  /** Original tags, retained so edits can merge rather than rebuild. */
  rawTags: string[][];
  /** Private boards only: the board view key as an `nsec`, when known. */
  viewKey?: string;
  /** Relay that accepted the board event, stored alongside the ref in a board list. */
  relayHint?: string;
}

export interface KanbanCard {
  /** The `d` tag. */
  id: string;
  /** Who signed this version — the rotator, after a rotation republished it. */
  pubkey: string;
  /**
   * Who actually wrote this card. Equals `pubkey` normally; after a key rotation
   * republished someone else's card, it is the original author recorded in the
   * payload (doc 05 §8) while `pubkey` is the rotator.
   */
  authorPubkey: string;
  /** True when this version is a rotator's copy of somebody else's card. */
  rotated: boolean;
  eventId: string;
  /** `30301:<pubkey>:<d>` of the owning board. */
  boardCoordinate: string;
  title: string;
  description: string;
  /** Column name on public boards; column id on private ones (Plan 2). */
  status?: string;
  rank: number;
  attachments: string[];
  assignees: string[];
  labels: string[];
  links: CardLink[];
  binned: boolean;
  isPrivate: boolean;
  createdAt: number;
  trackedKind?: number;
  trackedRef?: TrackedRef;
  rawTags: string[][];
}

export interface BoardDraft {
  title: string;
  description?: string;
  columns: Column[];
  maintainers?: string[];
  /** Private boards only. Client-enforced read-only role — see doc 07 §B3. */
  members?: string[];
  noZap?: boolean;
  /** Write a 32301 under a fresh view key instead of a public 30301. */
  private?: boolean;
  /** Reuse this view key (`nsec`) instead of minting one. */
  viewKey?: string;
  /** Board list (`d` tag) to link a private board into. */
  listId?: string;
}

export interface CardDraft {
  title: string;
  description?: string;
  status?: string;
  rank?: number;
  attachments?: string[];
  assignees?: string[];
  labels?: string[];
  links?: CardLink[];
}

export type BoardRole = "owner" | "maintainer" | "member";

/** One board's entry in a board list: where it is, and the key that opens it. */
export interface BoardListRef {
  /** `32301:<author>:<d>` */
  coordinate: string;
  relayHint: string;
  /** The board view key as an `nsec`. Empty when unknown. */
  viewKey: string;
  /** Role as last known. Advisory — the board's own tags are authoritative. */
  role: BoardRole;
}

export interface KanbanBoardList {
  /** The `d` tag. */
  id: string;
  eventId: string;
  title: string;
  boards: BoardListRef[];
  createdAt: number;
}

/** A board key delivered by gift wrap, after verification. Doc 05 §6. */
export interface BoardInvitation {
  /** `32301:<author>:<d>` */
  coordinate: string;
  relayHint: string;
  /** The board view key as an `nsec` — this is what the invitation is FOR. */
  viewKey: string;
  /** Advisory. The decrypted board's own tags are authoritative. */
  role: BoardRole;
  inviterPubkey: string;
  message: string;
  /** Event id of the gift wrap, so a client can dedupe and dismiss. */
  wrapId: string;
  createdAt: number;
}
