import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import type { CalendarCtx } from "../contracts";
import type { Invitation } from "../types";
import { buildSelfSignedDeletion, unwrapEvent, wrapEvent } from "../crypto/nip59";
import {
  buildInvitationMessage,
  buildInvitationRumorTags,
  buildPrivateEventUrl,
  invitationInboxFilters,
  parseInvitationRumor,
  senderDisplayName,
} from "../codec/invitation";
import { buildDeletionTags, indexDeletions, isDeleted } from "../discovery/deletions";
import { DEFAULT_CALENDAR_RELAYS, fetchRelayLists, outboxRelaysFor } from "../discovery/relays";
import { publishEvent, signAndPublish } from "./publish";

/**
 * Invitations — docs/protocol.md §6.
 *
 * An invitation is a capability, not a notification: the gift wrap carries the
 * event's view key. Everything here follows from that — wraps are verified on
 * read, and each is signed by its own ephemeral key so the recipient can delete
 * it later.
 */

/** kind-0 profile content for a pubkey, or undefined. */
export async function fetchProfileContent(
  ctx: CalendarCtx,
  pubkey: string,
): Promise<string | undefined> {
  const events = await ctx.runtime.querySync(ctx.relays, {
    kinds: [CALENDAR_KINDS.userProfile],
    authors: [pubkey],
    limit: 1,
  });
  return events.sort((a, b) => b.created_at - a.created_at)[0]?.content;
}

export interface SendInvitationsParams {
  /** Recipients. The event's author is NOT among them — see below. */
  participants: string[];
  authorPubkey: string;
  coordinate: string;
  dTag: string;
  eventKind: number;
  eventTitle: string;
  viewKeyNsec: string;
  relayHint: string;
  /** Extra PLAINTEXT tags on the wrap, e.g. `["booking","true"]`. */
  wrapTags?: string[][];
}

/**
 * One gift wrap per participant.
 *
 * The author is deliberately not a recipient. Upstream wraps `event.participants`
 * only (`events.ts:214`) — a self-wrap would put a bogus pending invitation to
 * your own event in your own inbox.
 *
 * Recipients' NIP-65 lists are fetched first so each wrap routes to the
 * inbox its recipient actually reads, not just the author's relays.
 */
export async function sendInvitations(
  ctx: CalendarCtx,
  params: SendInvitationsParams,
): Promise<Event[]> {
  const recipients = [...new Set(params.participants)].filter(
    (pubkey) => pubkey && pubkey !== params.authorPubkey,
  );
  if (recipients.length === 0) return [];

  const [profileContent, relayLists] = await Promise.all([
    fetchProfileContent(ctx, params.authorPubkey),
    fetchRelayLists(ctx.runtime, ctx.relays, recipients),
  ]);

  const message = buildInvitationMessage(
    senderDisplayName(profileContent, params.authorPubkey),
    params.eventTitle,
    buildPrivateEventUrl({
      appBaseUrl: ctx.appBaseUrl,
      kind: params.eventKind,
      pubkey: params.authorPubkey,
      dTag: params.dTag,
      viewKeyNsec: params.viewKeyNsec,
      relayHint: params.relayHint,
      defaultRelays: DEFAULT_CALENDAR_RELAYS,
    }),
  );

  const wraps: Event[] = [];
  for (const participant of recipients) {
    // Serial: a NIP-46 bunker typically rejects concurrent requests, and each
    // wrap needs its own seal (a seal is encrypted to exactly one recipient).
    const wrap = await wrapEvent(
      (signingNsec) => ({
        kind: CALENDAR_KINDS.rumor,
        content: message,
        tags: buildInvitationRumorTags({
          participantPubkey: participant,
          coordinate: params.coordinate,
          relayHint: params.relayHint,
          viewKeyNsec: params.viewKeyNsec,
          signingNsec,
        }),
      }),
      await ctx.getSigner(),
      participant,
      ctx.wrapKind,
      {
        timestamps: ctx.wrapTimestamps,
        tags: [...(params.wrapTags ?? []), ["k", String(ctx.wrapType)]],
      },
    );

    await publishEvent(
      ctx,
      wrap,
      outboxRelaysFor(ctx.relays, relayLists, [participant]),
    );
    wraps.push(wrap);
  }
  return wraps;
}

export interface FetchInvitationsOptions {
  since?: number;
  until?: number;
  limit?: number;
  /** Skip invitations already dismissed by the caller. Defaults to true. */
  honourDismissals?: boolean;
}

/**
 * The caller's invitation inbox.
 *
 * A wrap that fails to unwrap is skipped, not thrown: kind 1059 is shared by
 * every NIP-59 app, so an inbox legitimately contains DMs and other apps'
 * traffic that this signer cannot or should not read.
 *
 * Dismissals are honoured by **coordinate**, not by wrap id — otherwise
 * re-sending the same invitation under a new wrap resurrects something the
 * user already dismissed.
 */
export async function fetchInvitations(
  ctx: CalendarCtx,
  options: FetchInvitationsOptions = {},
): Promise<Invitation[]> {
  const signer = await ctx.getSigner();
  const pubkey = await signer.getPublicKey();

  const filters = invitationInboxFilters({
    pubkeys: [pubkey],
    wrapKind: ctx.wrapKind,
    wrapType: ctx.wrapType,
    includeLegacy: ctx.readLegacyWraps,
    since: options.since,
    until: options.until,
    limit: options.limit,
  });

  const wraps = new Map<string, Event>();
  for (const filter of filters) {
    for (const event of await ctx.runtime.querySync(ctx.relays, filter)) {
      wraps.set(event.id, event);
    }
  }

  const dismissals =
    options.honourDismissals === false
      ? indexDeletions([])
      : indexDeletions(
          await ctx.runtime.querySync(ctx.relays, {
            kinds: [CALENDAR_KINDS.deletion, CALENDAR_KINDS.participantRemoval],
            authors: [pubkey],
          }),
        );

  const invitations: Invitation[] = [];
  for (const wrap of wraps.values()) {
    if (isDeleted(dismissals, { id: wrap.id })) continue;
    let invitation: Invitation | null = null;
    try {
      // Serial for the same signer-concurrency reason as above.
      invitation = parseInvitationRumor(await unwrapEvent(wrap, signer), wrap.id);
    } catch {
      // Not ours, or not a calendar invitation. Both are normal.
      continue;
    }
    if (!invitation) continue;
    if (isDeleted(dismissals, { coordinate: invitation.coordinate })) continue;
    // Upstream never wraps for the author, but another client might; an
    // invitation to your own event is noise, not an invitation.
    if (invitation.senderPubkey === pubkey && invitation.authorPubkey === pubkey) continue;
    invitations.push(invitation);
  }

  invitations.sort((a, b) => b.createdAt - a.createdAt);
  return invitations;
}

/**
 * Dismisses an invitation.
 *
 * Preferred path: delete the wrap itself, signed by the wrap's own ephemeral
 * key from `signing_nsec`. NIP-09 honours a deletion only from the target's
 * author, and that author is a throwaway key the recipient only gets through
 * the encrypted rumor.
 *
 * Legacy wraps have no `signing_nsec`. For those we publish a signer-authored
 * deletion naming both the wrap and the event coordinate. A strict relay will
 * not honour it against a wrap it did not author, but it is a durable local
 * tombstone that `fetchInvitations` reads back — which is what keeps a
 * dismissed invitation dismissed across devices.
 */
export async function dismissInvitation(
  ctx: CalendarCtx,
  invitation: Pick<Invitation, "giftWrapId" | "coordinate" | "signingNsec">,
): Promise<void> {
  if (invitation.signingNsec) {
    const deletion = buildSelfSignedDeletion(
      invitation.signingNsec,
      [invitation.giftWrapId],
      ctx.wrapKind,
    );
    await publishEvent(ctx, deletion);
    return;
  }

  await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.deletion,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: buildDeletionTags({
      eventIds: [invitation.giftWrapId],
      coordinates: [invitation.coordinate],
      kinds: [ctx.wrapKind],
    }),
  });
}
