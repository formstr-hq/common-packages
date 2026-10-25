import { signerManager } from "@formstr/core";
import { KANBAN_KINDS, type BoardInvitation, type CardDraft, type Column, type KanbanBoard, type KanbanCard } from "@formstr/kanban-sdk";

import { getKanbanSdk } from "./sdk";

/** The three columns a fresh board starts with — same default as the app's dialog. */
export const DEFAULT_COLUMNS: Column[] = [
  { id: "todo", name: "To Do", order: 0 },
  { id: "doing", name: "In Progress", order: 1 },
  { id: "done", name: "Done", order: 2 },
];

/** A board's replaceable coordinate, `kind:pubkey:d`. */
export function boardCoordinate(board: KanbanBoard): string {
  const kind = board.isPrivate ? KANBAN_KINDS.privateBoard : KANBAN_KINDS.publicBoard;
  return `${kind}:${board.pubkey}:${board.id}`;
}

/** A `32301:` coordinate is private and needs a view key to read. */
export function isPrivateCoordinate(coordinate: string): boolean {
  return coordinate.startsWith(`${KANBAN_KINDS.privateBoard}:`);
}

/**
 * A card's `status` is the column **name** on a public board and the column
 * **id** on a private one (the two codecs differ). Every read or write of a
 * status threads through here so that branch lives exactly once.
 */
export function statusFor(board: KanbanBoard, column: Column): string {
  return board.isPrivate ? column.id : column.name;
}

/** Resolve a user-supplied column reference (name or id) to a column. */
export function columnFor(board: KanbanBoard, ref: string): Column | undefined {
  return board.columns.find((c) => statusFor(board, c) === ref || c.name === ref || c.id === ref);
}

export interface BoardSummary {
  coordinate: string;
  title: string;
  description: string;
  columns: string[];
  isPrivate: boolean;
  admins: string[];
  participants: string[];
  createdAt: number;
}

export interface CardSummary {
  id: string;
  title: string;
  description: string;
  status?: string;
  assignees: string[];
  labels: string[];
  board: string;
  createdAt: number;
}

/** Trim a board to the fields an AI call may see — never its view key. */
export function summarizeBoard(board: KanbanBoard): BoardSummary {
  return {
    coordinate: boardCoordinate(board),
    title: board.title,
    description: board.description,
    columns: [...board.columns].sort((a, b) => a.order - b.order).map((c) => c.name),
    isPrivate: board.isPrivate,
    admins: board.admins,
    participants: board.participants,
    createdAt: board.createdAt,
  };
}

/** Trim a card to the fields an AI call may see. */
export function summarizeCard(card: KanbanCard): CardSummary {
  return {
    id: card.id,
    title: card.title,
    description: card.description,
    status: card.status,
    assignees: card.assignees,
    labels: card.labels,
    board: card.boardCoordinate,
    createdAt: card.createdAt,
  };
}

/** The caller's own pubkey, via the blocking signer accessor. */
export async function myPubkey(): Promise<string> {
  return (await signerManager.getSigner()).getPublicKey();
}

/**
 * Every board the identity owns, maintains, or holds a private key for.
 * Mirrors the app's `fetchBoards` — the private path reads board lists itself
 * to recover each board's view key.
 */
export async function fetchMyBoards(pubkey: string): Promise<KanbanBoard[]> {
  const sdk = await getKanbanSdk();
  const [owned, maintained, priv] = await Promise.all([
    sdk.fetchBoards({ authors: [pubkey] }),
    sdk.fetchBoards({ maintainedBy: pubkey }),
    sdk.fetchPrivateBoards(),
  ]);

  const byKey = new Map<string, KanbanBoard>();
  for (const board of [...owned, ...maintained, ...priv]) byKey.set(boardCoordinate(board), board);
  return [...byKey.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Fetch a board by coordinate. A private coordinate has its view key resolved
 * internally from the caller's board lists — the key is never returned to a
 * caller, only used to decrypt.
 */
export async function resolveBoard(coordinate: string): Promise<KanbanBoard | null> {
  const sdk = await getKanbanSdk();
  const viewKey = isPrivateCoordinate(coordinate)
    ? await sdk.lookupBoardViewKey(coordinate)
    : undefined;
  return sdk.fetchBoardByCoordinate(coordinate, viewKey);
}

/** The live cards on a board, newest-first as the SDK returns them. */
export async function listCards(board: KanbanBoard): Promise<KanbanCard[]> {
  const sdk = await getKanbanSdk();
  return sdk.fetchCards(board);
}

/**
 * Cards assigned to `pubkey` across every board the caller can read. This is the
 * read the autonomous pick-up loop runs: an agent watches for work assigned to
 * it, then acts. Boards whose key this identity cannot use are skipped rather
 * than failing the whole sweep.
 */
export async function listAssignments(pubkey: string): Promise<CardSummary[]> {
  const [boards, sdk] = await Promise.all([fetchMyBoards(pubkey), getKanbanSdk()]);
  const out: CardSummary[] = [];
  for (const board of boards) {
    let cards: KanbanCard[];
    try {
      cards = await sdk.fetchCards(board);
    } catch {
      continue;
    }
    for (const card of cards) {
      if (!card.binned && card.assignees.includes(pubkey)) out.push(summarizeCard(card));
    }
  }
  return out;
}

/** Find a card by its `d` id on a board, or undefined. */
export async function findCard(board: KanbanBoard, cardId: string): Promise<KanbanCard | undefined> {
  return (await listCards(board)).find((c) => c.id === cardId);
}

/** Turn a list of column names into ordered `Column`s with stable slug ids. */
export function columnsFromNames(names: string[]): Column[] {
  const seen = new Set<string>();
  return names.map((name, order) => {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || `column-${order}`;
    let id = base;
    let n = 1;
    while (seen.has(id)) id = `${base}-${n++}`;
    seen.add(id);
    return { id, name, order };
  });
}

export async function createBoard(draft: {
  title: string;
  description?: string;
  columns: Column[];
  private?: boolean;
}): Promise<KanbanBoard> {
  const sdk = await getKanbanSdk();
  return sdk.createBoard(draft);
}

export async function createCard(board: KanbanBoard, draft: CardDraft): Promise<KanbanCard> {
  const sdk = await getKanbanSdk();
  return sdk.createCard(board, draft);
}

export async function updateCard(
  board: KanbanBoard,
  card: KanbanCard,
  changes: Partial<CardDraft>,
): Promise<KanbanCard> {
  const sdk = await getKanbanSdk();
  return sdk.updateCard(board, card, changes);
}

/** Move a card into `targetStatus` (a column ref), appended at the end. */
export async function moveCard(
  board: KanbanBoard,
  cardId: string,
  targetStatus: string,
  targetIndex?: number,
): Promise<KanbanCard> {
  const sdk = await getKanbanSdk();
  const cards = await sdk.fetchCards(board);
  const index =
    targetIndex ??
    cards.filter((c) => !c.binned && c.status === targetStatus).length;
  return sdk.moveCard(board, cards, cardId, targetStatus, index);
}

export async function addComment(board: KanbanBoard, cardId: string, content: string) {
  const sdk = await getKanbanSdk();
  return sdk.createComment(board, cardId, { content });
}

/** Comments for one card, or the whole board when `cardId` is omitted; oldest first. */
export async function listComments(board: KanbanBoard, cardId?: string) {
  const sdk = await getKanbanSdk();
  const comments = await sdk.fetchComments(board, cardId);
  return [...comments].sort((a, b) => a.createdAt - b.createdAt);
}

export async function deleteCard(card: KanbanCard): Promise<void> {
  const sdk = await getKanbanSdk();
  await sdk.deleteCard(card);
}

export async function deleteBoard(board: KanbanBoard): Promise<void> {
  const sdk = await getKanbanSdk();
  await sdk.deleteBoard(board);
}

/** The first column by order — a board's "not started" lane. */
export function firstColumn(board: KanbanBoard): Column | undefined {
  return [...board.columns].sort((a, b) => a.order - b.order)[0];
}

/** The column one step past first — where a picked-up card lands. */
export function nextColumn(board: KanbanBoard): Column | undefined {
  const sorted = [...board.columns].sort((a, b) => a.order - b.order);
  return sorted[1] ?? sorted[0];
}

/**
 * Cards assigned to `pubkey` that sit in their board's first column — i.e. work
 * not yet picked up. This is the agent's inbox: the loop that watches for new
 * assignments reads exactly this.
 */
export async function openAssignments(pubkey: string, boardCoordinate?: string): Promise<CardSummary[]> {
  const sdk = await getKanbanSdk();
  const boards = boardCoordinate
    ? [await resolveBoard(boardCoordinate)].filter((b): b is KanbanBoard => b !== null)
    : await fetchMyBoards(pubkey);
  const out: CardSummary[] = [];
  for (const board of boards) {
    const first = firstColumn(board);
    if (!first) continue;
    const firstStatus = statusFor(board, first);
    let cards: KanbanCard[];
    try {
      cards = await sdk.fetchCards(board);
    } catch {
      continue;
    }
    for (const card of cards) {
      if (!card.binned && card.assignees.includes(pubkey) && card.status === firstStatus) {
        out.push(summarizeCard(card));
      }
    }
  }
  return out;
}

/**
 * Take a card off the un-started lane: move it one column forward. Idempotent —
 * a card that already left the first column is returned unchanged with
 * `claimed: false`, so a racing or repeated pick-up never re-moves it.
 */
export async function claimCard(
  board: KanbanBoard,
  card: KanbanCard,
  toStatus?: string,
): Promise<{ card: KanbanCard; claimed: boolean }> {
  const first = firstColumn(board);
  if (first && card.status !== statusFor(board, first)) {
    return { card, claimed: false };
  }
  const target = (toStatus ? columnFor(board, toStatus) : undefined) ?? nextColumn(board);
  if (!target) throw new Error("This board has no columns to move the card into.");
  const moved = await moveCard(board, card.id, statusFor(board, target), undefined);
  return { card: moved, claimed: true };
}

/** Build a `CardDraft`, resolving a flexible `status` ref to the wire value. */
export function cardDraft(
  board: KanbanBoard,
  input: {
    title: string;
    description?: string;
    status?: string;
    assignees?: string[];
    labels?: string[];
  },
): CardDraft {
  const first = [...board.columns].sort((a, b) => a.order - b.order)[0];
  const column = input.status ? columnFor(board, input.status) : first;
  const draft: CardDraft = { title: input.title };
  if (input.description !== undefined) draft.description = input.description;
  if (column) draft.status = statusFor(board, column);
  if (input.assignees) draft.assignees = input.assignees;
  if (input.labels) draft.labels = input.labels;
  return draft;
}

// ── Invitations (sharing) ─────────────────────────────

/** An invitation as a tool may surface it — never the view key or wrap key. */
export interface InvitationSummary {
  coordinate: string;
  role: string;
  inviter: string;
  message: string;
  wrapId: string;
  createdAt: number;
}

/** Trim an invitation to tool-visible fields — its key stays inside the SDK. */
export function summarizeInvitation(inv: BoardInvitation): InvitationSummary {
  return {
    coordinate: inv.coordinate,
    role: inv.role,
    inviter: inv.inviterPubkey,
    message: inv.message,
    wrapId: inv.wrapId,
    createdAt: inv.createdAt,
  };
}

/** Resolve a wrap id, possibly a prefix, to exactly one pending invitation. */
async function resolvePending(wrapId: string): Promise<BoardInvitation> {
  const invites = await (await getKanbanSdk()).fetchInvitations();
  const exact = invites.find((i) => i.wrapId === wrapId);
  if (exact) return exact;
  const matches = invites.filter((i) => i.wrapId.startsWith(wrapId));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`No pending kanban invitation matches wrap id ${wrapId}.`);
  }
  throw new Error(
    `Wrap id ${wrapId} matches ${matches.length} pending invitations; pass a longer prefix.`,
  );
}

/** Pending private-board invitations addressed to us, minus anything accepted or dismissed. */
export async function listInvitations(): Promise<InvitationSummary[]> {
  return (await (await getKanbanSdk()).fetchInvitations()).map(summarizeInvitation);
}

/**
 * Accept: the SDK proves the offered key actually opens the board, then links
 * it into our board list. Returns the joined board — a caller goes straight to
 * `list_kanban_cards` from here.
 */
export async function acceptInvitation(wrapId: string, listId?: string): Promise<BoardSummary> {
  const sdk = await getKanbanSdk();
  const invitation = await resolvePending(wrapId);
  await sdk.acceptInvitation(invitation, listId ? { listId } : {});
  const board = await sdk.fetchBoardByCoordinate(invitation.coordinate, invitation.viewKey);
  if (!board) {
    throw new Error(`The board at ${invitation.coordinate} did not resolve after accepting.`);
  }
  return summarizeBoard(board);
}

/** Decline: NIP-09-delete the wrap via its ephemeral key when possible, else file an opt-out. */
export async function dismissInvitation(wrapId: string): Promise<void> {
  const sdk = await getKanbanSdk();
  await sdk.dismissInvitation(await resolvePending(wrapId));
}

/**
 * Invite pubkeys to a board we administer: republishes the roster and sends
 * each invitee the view key as a NIP-59 gift wrap to THEIR inbox relays.
 */
export async function inviteMembers(
  coordinate: string,
  invitees: { pubkey: string; role: "admin" | "participant" }[],
  message?: string,
): Promise<BoardSummary> {
  const board = await resolveBoard(coordinate);
  if (!board) throw new Error(`No kanban board at ${coordinate}.`);
  const updated = await (await getKanbanSdk()).invite(board, invitees, message);
  return summarizeBoard(updated);
}
