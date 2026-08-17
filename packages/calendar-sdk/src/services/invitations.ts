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
import { fetchRelayLists, outboxRelaysFor } from "../discovery/relays";
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
    ctx.appBaseUrl
      ? buildPrivateEventUrl({
          appBaseUrl: ctx.appBaseUrl,
          kind: params.eventKind,
          pubkey: params.authorPubkey,
          dTag: params.dTag,
          viewKeyNsec: params.viewKeyNsec,
          relayHint: params.relayHint,
          fallbackRelays: ctx.relays,
        })
      : undefined,
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
      { tags: [...(params.wrapTags ?? []), ["k", String(CALENDAR_KINDS.invitationWrapType)]] },
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

/**
 * Wraps that have been retracted by a kind-5 signed with the wrap's OWN key.
 *
 * A compliant relay stops serving a deleted event, so on a good relay this
 * finds nothing. But NIP-09 enforcement is optional and uneven, and a
 * self-signed dismissal is authored by the wrap's ephemeral key — not by the
 * dismisser — so the caller's own-deletions index cannot see it either. Without
 * this check a dismissed invitation reappears on the next read.
 *
 * The author check IS the authorization: NIP-09 honours a deletion only from
 * the target event's author, so a kind-5 naming a wrap counts only when it was
 * signed by that wrap's own pubkey.
 */
async function fetchRetractedWraps(
  ctx: CalendarCtx,
  wraps: Map<string, Event>,
): Promise<Set<string>> {
  const retracted = new Set<string>();
  if (wraps.size === 0) return retracted;

  const deletions = await ctx.runtime.querySync(ctx.relays, {
    kinds: [CALENDAR_KINDS.deletion],
    "#e": [...wraps.keys()],
  });

  for (const deletion of deletions) {
    for (const tag of deletion.tags) {
      if (tag[0] !== "e" || !tag[1]) continue;
      const wrap = wraps.get(tag[1]);
      if (wrap && deletion.pubkey === wrap.pubkey) retracted.add(tag[1]);
    }
  }
  return retracted;
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

  const honour = options.honourDismissals !== false;
  const dismissals = honour
    ? indexDeletions(
        await ctx.runtime.querySync(ctx.relays, {
          kinds: [CALENDAR_KINDS.deletion],
          authors: [pubkey],
        }),
      )
    : indexDeletions([]);

  const retracted = honour ? await fetchRetractedWraps(ctx, wraps) : new Set<string>();

  const invitations: Invitation[] = [];
  for (const wrap of wraps.values()) {
    if (retracted.has(wrap.id)) continue;
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
 * Dismisses an invitation, with two deletions that do different jobs.
 *
 * The wrap-signed one is what a compliant relay actually honours: NIP-09 acts
 * only on a deletion from the target's own author, and a wrap's author is the
 * throwaway key whose nsec rides inside the encrypted rumor.
 *
 * The signer-authored one is published regardless, because NIP-09 enforcement
 * is optional and uneven. A non-conformant relay keeps serving the wrap, and
 * this kind-5 — naming both the wrap and the event coordinate — is the durable
 * tombstone `fetchInvitations` reads back, which is what keeps the invitation
 * dismissed on every device.
 */
export async function dismissInvitation(
  ctx: CalendarCtx,
  invitation: Pick<Invitation, "giftWrapId" | "coordinate" | "signingNsec">,
): Promise<void> {
  if (invitation.signingNsec) {
    await publishEvent(
      ctx,
      buildSelfSignedDeletion(invitation.signingNsec, [invitation.giftWrapId]),
    );
  }

  await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.deletion,
    content: "",
    created_at: Math.floor(Date.now() / 1000),
    tags: buildDeletionTags({
      eventIds: [invitation.giftWrapId],
      coordinates: [invitation.coordinate],
      kinds: [CALENDAR_KINDS.giftWrap],
    }),
  });
}
