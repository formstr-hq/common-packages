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
  noZap: boolean;
  createdAt: number;
  isPrivate: boolean;
  /** True for v0 boards: columns in JSON content, cards listed by board `a` tags. */
  legacy: boolean;
  /** Original tags, retained so edits can merge rather than rebuild. */
  rawTags: string[][];
}

export interface KanbanCard {
  /** The `d` tag. */
  id: string;
  pubkey: string;
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
  noZap?: boolean;
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
