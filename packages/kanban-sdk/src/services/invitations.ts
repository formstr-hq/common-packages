import { boardCoordinate } from "../codec/board";
import { buildInvitationRumorTags, parseInvitationRumor } from "../codec/invitation";
import { InvitationVerificationError, type KanbanCtx } from "../contracts";
import { buildSelfSignedDeletion, unwrapEvent, wrapEvent } from "../crypto/nip59";
import { nextCreatedAt } from "../discovery/dedupe";
import { collectDeleted } from "../discovery/deletions";
import { fetchRelayListsForPubkeys, getInvitationInboxRelays } from "../discovery/relays";
import { KANBAN_KINDS } from "../kinds";
import type { BoardInvitation, BoardRole, KanbanBoard, KanbanBoardList } from "../types";
import { addBoardToList, ensureBoardList, fetchBoardLists } from "./boardLists";
import { fetchPrivateBoardByCoordinate, resolveBoardViewKey } from "./boards";

/**
 * Gift-wrap the board's view key to each recipient and publish each wrap to THAT
 * recipient's inbox relays (doc 05 §10). Publishing to our own relay set instead
 * is the most common reason an invitation silently never arrives.
 */
export async function sendInvitations(
  ctx: KanbanCtx,
  board: KanbanBoard,
  recipients: { pubkey: string; role: BoardRole }[],
  message = "",
): Promise<void> {
  if (recipients.length === 0) return;

  const signer = await ctx.getSigner();
  const viewKey = await resolveBoardViewKey(ctx, board);
  const coordinate = boardCoordinate(board);
  const relayHint = board.relayHint ?? ctx.relays[0] ?? "";

  const inboxes = await fetchRelayListsForPubkeys(
    ctx.runtime,
    ctx.relays,
    recipients.map((r) => r.pubkey),
  );

  const publishes: Promise<void>[] = [];
  for (const recipient of recipients) {
    // Wrap serially — remote signers (NIP-46) typically reject concurrent
    // requests — but let the publishes overlap.
    const wrap = await wrapEvent(
      // Function form: the wrap's signing key has to be known while the rumor is
      // still being built, because the rumor carries it (see `signing_nsec`).
      (signingNsec) => ({
        kind: KANBAN_KINDS.inviteRumor,
        content: message,
        tags: buildInvitationRumorTags({
          coordinate,
          relayHint,
          viewKey,
          role: recipient.role,
          signingNsec,
        }),
      }),
      signer,
      recipient.pubkey,
      ctx.wrapKind,
      // `k` is what keeps the inbox query narrow once every app shares kind 1059.
      { timestamps: ctx.wrapTimestamps, tags: [["k", String(ctx.wrapType)]] },
    );
    publishes.push(ctx.runtime.publish(inboxes.get(recipient.pubkey) ?? ctx.relays, wrap));
  }
  await Promise.all(publishes);
}

/**
 * Pending invitations addressed to us: unwrapped, verified, deduplicated by
 * board, and minus anything already accepted or dismissed.
 */
export async function fetchInvitations(ctx: KanbanCtx): Promise<BoardInvitation[]> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();
  const inbox = await getInvitationInboxRelays(ctx.runtime, ctx.relays, pubkey);

  const [current, legacy, removals, lists] = await Promise.all([
    ctx.runtime.querySync(inbox, {
      kinds: [ctx.wrapKind],
      "#p": [pubkey],
      "#k": [String(ctx.wrapType)],
    }),
    // Wraps sent before the move to 1059 carry no `k` tag and used the private
    // kind as the wire kind. Dropping this query would silently strand every
    // invitation already in flight.
    ctx.runtime.querySync(inbox, { kinds: [ctx.wrapType], "#p": [pubkey] }),
    ctx.runtime.querySync(inbox, {
      kinds: [KANBAN_KINDS.membershipRemoval],
      authors: [pubkey],
    }),
    fetchBoardLists(ctx),
  ]);
  // A caller who set wrapKind === wrapType gets the same events from both.
  const deduped = [...new Map([...current, ...legacy].map((e) => [e.id, e])).values()];

  // Dismissal deletes the wrap, but NIP-09 is a request: a relay may ignore it,
  // and a relay that never received it still serves the wrap. Without this the
  // invitation returns on every refresh. Authors are the wraps' own ephemeral
  // keys, which is who signs a dismissal.
  const wraps =
    deduped.length === 0
      ? deduped
      : await (async () => {
          const deletions = await ctx.runtime.querySync(inbox, {
            kinds: [KANBAN_KINDS.deletion],
            authors: [...new Set(deduped.map((wrap) => wrap.pubkey))],
          });
          const deleted = collectDeleted(deletions);
          return deduped.filter((wrap) => !deleted.ids.has(wrap.id));
        })();

  // When we declined, and for which board. A later re-invitation must still
  // surface: declining is about the invitation in hand, not a standing refusal
  // of the board forever.
  const dismissedAt = new Map<string, number>();
  for (const event of removals) {
    for (const tag of event.tags) {
      if (tag[0] !== "a" || !tag[1]) continue;
      dismissedAt.set(tag[1], Math.max(dismissedAt.get(tag[1]) ?? 0, event.created_at));
    }
  }

  // Which key we already hold for each board. A re-invitation carrying a
  // DIFFERENT key is a rotation (doc 05 §8 step 4) and must surface — our stored
  // key is stale and opens nothing. Suppressing it by coordinate alone would
  // leave the member silently locked out of a board they still belong to.
  const acceptedKeys = new Map<string, string>();
  for (const list of lists) {
    for (const ref of list.boards) acceptedKeys.set(ref.coordinate, ref.viewKey);
  }

  // One entry per board: a re-invitation (say, after a key rotation) supersedes
  // the older wrap rather than showing up as a second pending item.
  const newest = new Map<string, BoardInvitation>();
  for (const wrap of wraps) {
    let invitation: BoardInvitation | null;
    try {
      const rumor = await unwrapEvent(wrap, signer);
      invitation = parseInvitationRumor(rumor, wrap.id);
    } catch {
      // Not ours, malformed, or failed the seal-signer check. A forged invitation
      // carries a key the user would act on, so it must never surface.
      continue;
    }
    if (!invitation) continue;
    if (invitation.inviterPubkey === pubkey) continue; // our own, echoed back
    if (acceptedKeys.get(invitation.coordinate) === invitation.viewKey) continue;
    if ((dismissedAt.get(invitation.coordinate) ?? 0) >= invitation.createdAt) continue;

    const previous = newest.get(invitation.coordinate);
    // Newest wins; ties break by lowest wrap id. A rumor's created_at has
    // one-second resolution, so two invitations sent in the same second are
    // genuinely indistinguishable in age — the id tie-break only buys
    // determinism, so every client picks the same one instead of whichever the
    // relay happened to return first. Accepting a stale key is not silent:
    // `acceptInvitation` verifies the key opens the board before storing it.
    if (
      !previous ||
      invitation.createdAt > previous.createdAt ||
      (invitation.createdAt === previous.createdAt && invitation.wrapId < previous.wrapId)
    ) {
      newest.set(invitation.coordinate, invitation);
    }
  }

  return [...newest.values()];
}

/**
 * Accept: prove the key actually opens the board, then store the ref in our own
 * board list. The proof matters — a ref whose key does not work is a board the
 * user will see listed and never be able to open.
 */
export async function acceptInvitation(
  ctx: KanbanCtx,
  invitation: BoardInvitation,
  opts: { listId?: string } = {},
): Promise<KanbanBoardList> {
  const board = await fetchPrivateBoardByCoordinate(ctx, invitation.coordinate, invitation.viewKey);
  if (!board) {
    throw new InvitationVerificationError(
      `the board at ${invitation.coordinate} could not be read with the key offered`,
    );
  }

  const list = await ensureBoardList(ctx, opts.listId);
  return addBoardToList(ctx, list, {
    coordinate: invitation.coordinate,
    relayHint: invitation.relayHint,
    viewKey: invitation.viewKey,
    role: invitation.role,
  });
}

/**
 * Decline.
 *
 * Preferred path: a NIP-09 deletion of the wrap, signed with the wrap's own
 * ephemeral key. Relays that honour NIP-09 stop serving it, and the deletion
 * says nothing about us — an anonymous author and an `e` tag, with no link to
 * our pubkey and none to the board.
 *
 * The kind-84 fallback is the opposite on both counts: authored by us and
 * carrying the board coordinate in plaintext, so it announces to anyone
 * watching which private board we were invited to and declined. Used only for
 * invitations sent before `signing_nsec` existed, where nothing else can work.
 */
export async function dismissInvitation(
  ctx: KanbanCtx,
  invitation: BoardInvitation,
): Promise<void> {
  if (invitation.signingNsec) {
    const deletion = buildSelfSignedDeletion(
      invitation.signingNsec,
      [invitation.wrapId],
      ctx.wrapKind,
    );
    await ctx.runtime.publish(ctx.relays, deletion);
    return;
  }

  const signer = await ctx.getSigner();
  const signed = await signer.signEvent({
    kind: KANBAN_KINDS.membershipRemoval,
    created_at: nextCreatedAt(),
    tags: [
      ["a", invitation.coordinate],
      ["e", invitation.wrapId],
      ["k", String(KANBAN_KINDS.privateBoard)],
    ],
    content: "",
  });
  await ctx.runtime.publish(ctx.relays, signed);
}
