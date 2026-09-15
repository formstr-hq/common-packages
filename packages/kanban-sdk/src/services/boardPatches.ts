import type { Event, Filter } from "nostr-tools";

import { boardCoordinate } from "../codec/board";
import { buildPatchTags, parsePatch } from "../codec/boardPatch";
import type { BoardPatch, BoardPatchDraft } from "../codec/boardPatch";
import { NotAnAdminError, type KanbanCtx } from "../contracts";
import { blindedPointer } from "../crypto/blindedPointer";
import { decryptWithViewKey, encryptWithViewKey, viewKeyFromNsec } from "../crypto/viewKey";
import { nextCreatedAt } from "../discovery/dedupe";
import { KANBAN_KINDS } from "../kinds";
import type { Column, KanbanBoard } from "../types";

import { canAdminister } from "./access";

/** How a public board's patches address it: creator plus `d`, unique per board. */
export function publicBoardRef(board: Pick<KanbanBoard, "pubkey" | "id">): string {
  return `${board.pubkey}:${board.id}`;
}

/**
 * How a private board's patches address it: the same blinded pointer its cards
 * carry, so the `d` tag reveals no coordinate to anyone without the view key.
 */
export function privateBoardRef(
  board: Pick<KanbanBoard, "pubkey" | "id"> & { isPrivate?: boolean },
  viewKeyNsec: string,
): string {
  return blindedPointer(viewKeyFromNsec(viewKeyNsec).pubkey, boardCoordinate(board));
}

/**
 * The board as everyone sees it: the creator's event with its admins' patches
 * folded over the top.
 *
 * Deterministic, so two clients holding the same events agree without talking.
 * Patches apply oldest first, ties broken on the author's pubkey, and the
 * columns come out sorted by order then id.
 *
 * Three things a patch may never do, all checked here rather than trusted to
 * the writer:
 *  - **Grant admin.** Only the base board's `admin` tags decide who counts, so
 *    an admin cannot promote a peer or escalate past the creator. The codec
 *    does not even parse an `admin` row.
 *  - **Remove the creator or another admin.** Otherwise two admins could evict
 *    each other, or either could evict the owner from their own board.
 *  - **Outlive a demotion.** The filter reads the base's *current* admin list,
 *    so demoting someone makes every patch they ever wrote inert with no
 *    tombstone and no cooperation from them.
 */
export function foldPatches(board: KanbanBoard, patches: BoardPatch[], ref: string): KanbanBoard {
  const admins = new Set(board.admins);

  const applicable = patches
    .filter((patch) => patch.boardRef === ref)
    .filter((patch) => admins.has(patch.author))
    // Strictly after: a patch written in the same second as the bake is one the
    // bake already folded in, and re-applying it would resurrect what it replaced.
    .filter((patch) => patch.createdAt > board.baked)
    .sort((a, b) => a.createdAt - b.createdAt || (a.author < b.author ? -1 : 1));

  if (applicable.length === 0) return board;

  let title = board.title;
  let description = board.description;
  const columns = new Map<string, Column>(board.columns.map((column) => [column.id, column]));
  const participants = new Set(board.participants);
  const untouchable = new Set([board.pubkey, ...board.admins]);

  for (const patch of applicable) {
    if (patch.title !== undefined) title = patch.title;
    if (patch.description !== undefined) description = patch.description;

    for (const column of patch.columns) columns.set(column.id, column);
    for (const id of patch.columnsRemoved) columns.delete(id);

    for (const pubkey of patch.participantsAdded) {
      if (!untouchable.has(pubkey)) participants.add(pubkey);
    }
    for (const pubkey of patch.participantsRemoved) {
      if (!untouchable.has(pubkey)) participants.delete(pubkey);
    }
  }

  return {
    ...board,
    title,
    description,
    // Tie-break on id: two admins can independently pick the same order, and
    // without it the two clients would render the columns in different orders.
    columns: [...columns.values()].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1)),
    participants: [...participants],
  };
}

/**
 * Fold a new edit into the admin's existing patch for this board.
 *
 * The patch is addressable, so publishing an edit on its own replaces the
 * previous one outright — an admin's second column would silently delete their
 * first. Everything they have already changed has to be republished with it.
 *
 * Adding a column back cancels its removal, and re-inviting someone cancels
 * their removal, so the two lists never contradict each other.
 */
export function mergePatch(previous: BoardPatch | null, draft: BoardPatchDraft): BoardPatchDraft {
  const columns = new Map<string, Column>((previous?.columns ?? []).map((c) => [c.id, c]));
  for (const column of draft.columns ?? []) columns.set(column.id, column);
  for (const id of draft.columnsRemoved ?? []) columns.delete(id);

  const removedColumns = new Set([
    ...(previous?.columnsRemoved ?? []),
    ...(draft.columnsRemoved ?? []),
  ]);
  for (const id of columns.keys()) removedColumns.delete(id);

  const added = new Set([...(previous?.participantsAdded ?? []), ...(draft.participantsAdded ?? [])]);
  const removed = new Set([
    ...(previous?.participantsRemoved ?? []),
    ...(draft.participantsRemoved ?? []),
  ]);
  for (const pubkey of draft.participantsAdded ?? []) removed.delete(pubkey);
  for (const pubkey of draft.participantsRemoved ?? []) added.delete(pubkey);

  return {
    title: draft.title ?? previous?.title,
    description: draft.description ?? previous?.description,
    columns: [...columns.values()],
    columnsRemoved: [...removedColumns],
    participantsAdded: [...added],
    participantsRemoved: [...removed],
  };
}

/** One board to collect patches for, and everything needed to read them. */
export interface PatchTarget {
  /** `publicBoardRef(board)`, or the blinded pointer on a private board. */
  ref: string;
  /** The board's own `admin` tags. Nobody else's patch counts. */
  admins: string[];
  isPrivate: boolean;
  /** Required for a private board: the key its patches are encrypted under. */
  viewKey?: string;
}

/**
 * Every applicable patch for a set of boards, keyed by board ref.
 *
 * One query for all the public boards and one for all the private ones, rather
 * than a round trip per board: a board list of twenty would otherwise cost
 * twenty queries on every load.
 *
 * A board with no admins is skipped outright — there is nobody whose patch
 * could count, so the query would be a guaranteed miss.
 */
export async function fetchPatches(
  ctx: KanbanCtx,
  targets: PatchTarget[],
): Promise<Map<string, BoardPatch[]>> {
  const usable = targets.filter((t) => t.admins.length > 0 && (!t.isPrivate || t.viewKey));
  const byRef = new Map(usable.map((t) => [t.ref, t]));
  const results = new Map<string, BoardPatch[]>();
  if (usable.length === 0) return results;

  const query = async (isPrivate: boolean): Promise<Event[]> => {
    const group = usable.filter((t) => t.isPrivate === isPrivate);
    if (group.length === 0) return [];
    const filter: Filter = {
      kinds: [isPrivate ? KANBAN_KINDS.privateAdminPatch : KANBAN_KINDS.adminPatch],
      authors: [...new Set(group.flatMap((t) => t.admins))],
      "#d": group.map((t) => t.ref),
    };
    return ctx.runtime.querySync(ctx.relays, filter);
  };

  const [publicEvents, privateEvents] = await Promise.all([query(false), query(true)]);

  // One patch per author per board. Relays serve the newest of an addressable
  // event, but a union across several of them can still hand back both.
  const newest = new Map<string, BoardPatch>();

  for (const event of [...publicEvents, ...privateEvents]) {
    const ref = event.tags.find((t) => t[0] === "d")?.[1];
    const target = ref ? byRef.get(ref) : undefined;
    if (!target || !target.admins.includes(event.pubkey)) continue;

    let patch: BoardPatch | null = null;
    if (target.isPrivate) {
      try {
        const payload = JSON.parse(await decryptWithViewKey(target.viewKey!, event.content));
        if (Array.isArray(payload)) patch = parsePatch(event, payload as string[][]);
      } catch {
        // Written under a key we no longer hold, most likely from before a
        // rotation. An unreadable patch is an ordinary state, not an error.
        continue;
      }
    } else {
      patch = parsePatch(event);
    }
    if (!patch) continue;

    const key = `${patch.author}:${patch.boardRef}`;
    const previous = newest.get(key);
    if (!previous || patch.createdAt > previous.createdAt) newest.set(key, patch);
  }

  for (const patch of newest.values()) {
    const bucket = results.get(patch.boardRef) ?? [];
    bucket.push(patch);
    results.set(patch.boardRef, bucket);
  }
  return results;
}

/**
 * Publish this admin's patch for a board, folding it into whatever they had
 * already changed.
 *
 * There is no deletion path on purpose: the patch is replaceable, so an admin
 * withdrawing everything publishes an empty one.
 */
export async function publishPatch(
  ctx: KanbanCtx,
  board: KanbanBoard,
  ref: string,
  draft: BoardPatchDraft,
  viewKeyNsec?: string,
): Promise<BoardPatch> {
  const signer = await ctx.getSigner();
  const author = await signer.getPublicKey();
  if (!canAdminister(board, author)) throw new NotAnAdminError(author, ref);

  const existing =
    (
      await fetchPatches(ctx, [
        { ref, admins: [author], isPrivate: board.isPrivate, viewKey: viewKeyNsec },
      ])
    )
      .get(ref)
      ?.find((patch) => patch.author === author) ?? null;

  const tags = buildPatchTags(mergePatch(existing, draft), ref);

  // Past the watermark as well as past our own last patch: a patch written in
  // the same second the creator baked is inert the moment it lands.
  const floor = Math.max(existing?.createdAt ?? 0, board.baked);
  const createdAt = nextCreatedAt(floor || undefined);

  const signed = await signer.signEvent(
    board.isPrivate
      ? {
          kind: KANBAN_KINDS.privateAdminPatch,
          created_at: createdAt,
          tags: [["d", ref]],
          content: await encryptWithViewKey(viewKeyNsec!, JSON.stringify(tags)),
        }
      : { kind: KANBAN_KINDS.adminPatch, created_at: createdAt, tags, content: "" },
  );
  await ctx.runtime.publish(ctx.relays, signed);

  const patch = parsePatch(signed, board.isPrivate ? tags : undefined);
  if (!patch) throw new Error("Built an unparseable board patch");
  return patch;
}
