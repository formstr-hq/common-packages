import { nip19 } from "nostr-tools";
import type { Filter } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import type { Invitation } from "../types";
import type { Rumor } from "../crypto/nip59";
import { parseCoordinate } from "./identifiers";

/**
 * Invitation rumor codec — docs/protocol.md §6. Mirrors the rumor construction
 * in nostr-calendar's `src/nostr/events.ts` and the reader in
 * `getDetailsFromGiftWrap`.
 *
 * The rumor is NIP-17 kind 14 with a human-readable `content`, so the
 * invitation renders as a real direct message in any NIP-17 client rather than
 * as an opaque blob.
 */

/** `{npub…}` truncated the way upstream does when a profile has no name. */
export function fallbackSenderName(pubkey: string): string {
  return nip19.npubEncode(pubkey).slice(0, 12);
}

/** `display_name` → `name` → truncated npub, matching upstream's precedence. */
export function senderDisplayName(profileContent: string | undefined, pubkey: string): string {
  if (profileContent) {
    try {
      const profile = JSON.parse(profileContent) as { display_name?: string; name?: string };
      const name = profile.display_name || profile.name;
      if (name) return name;
    } catch {
      // Malformed profile content — fall through to the pubkey form.
    }
  }
  return fallbackSenderName(pubkey);
}

export function buildInvitationMessage(
  senderName: string,
  title: string,
  eventUrl: string,
): string {
  return `${senderName} has invited you to an event: ${title}. View more details and add it to your calendar here: ${eventUrl}`;
}

/**
 * The deep link embedded in the invitation message. The view key rides in the
 * query string, so anyone with the link can open the event — that is the point,
 * and it is why the link must only ever be shared through the gift wrap.
 */
export function buildPrivateEventUrl(params: {
  appBaseUrl: string;
  kind: number;
  pubkey: string;
  dTag: string;
  viewKeyNsec: string;
  relayHint?: string;
  defaultRelays?: readonly string[];
}): string {
  const relays = params.relayHint
    ? [params.relayHint]
    : params.defaultRelays && params.defaultRelays.length > 0
      ? [...params.defaultRelays]
      : undefined;
  const naddr = nip19.naddrEncode({
    kind: params.kind,
    pubkey: params.pubkey,
    identifier: params.dTag,
    ...(relays ? { relays } : {}),
  });
  const base = params.appBaseUrl.replace(/\/+$/, "");
  return `${base}/event/${naddr}?viewKey=${encodeURIComponent(params.viewKeyNsec)}`;
}

export function buildInvitationRumorTags(params: {
  participantPubkey: string;
  coordinate: string;
  relayHint: string;
  viewKeyNsec: string;
  signingNsec: string;
}): string[][] {
  return [
    ["p", params.participantPubkey],
    ["a", params.coordinate, params.relayHint],
    ["viewKey", params.viewKeyNsec],
    // Only reachable after decryption, so it never leaks. It is what lets the
    // recipient delete this wrap — docs/protocol.md §6.2.
    ["signing_nsec", params.signingNsec],
  ];
}

/**
 * Verified rumor → `Invitation`.
 *
 * Returns `null` rather than throwing when the rumor is not a calendar
 * invitation: an inbox of kind-1059 wraps legitimately contains other apps'
 * traffic, and one foreign wrap must not abort the whole inbox read.
 *
 * `senderPubkey` comes from the rumor's pubkey, which `unwrapEvent` has already
 * checked against the seal's signer — never trust it without that check.
 */
export function parseInvitationRumor(rumor: Rumor, giftWrapId: string): Invitation | null {
  const aTag = rumor.tags.find((t) => t[0] === "a");
  if (!aTag?.[1]) return null;

  const parsed = parseCoordinate(aTag[1]);
  if (!parsed) return null;

  const viewKey = rumor.tags.find((t) => t[0] === "viewKey")?.[1];
  if (!viewKey) return null;

  return {
    giftWrapId,
    senderPubkey: rumor.pubkey,
    recipientPubkey: rumor.tags.find((t) => t[0] === "p")?.[1] ?? "",
    eventId: parsed.dTag,
    kind: parsed.kind,
    authorPubkey: parsed.authorPubkey,
    coordinate: aTag[1],
    viewKey,
    relayHint: aTag[2] ?? "",
    message: rumor.content || undefined,
    // Absent on invitations sent before this tag existed; callers fall back to
    // a signer-authored deletion request.
    signingNsec: rumor.tags.find((t) => t[0] === "signing_nsec")?.[1] || undefined,
    createdAt: rumor.created_at,
  };
}

/**
 * Filters for the invitation inbox — docs/protocol.md §6.1.
 *
 * Two filters, and they cannot be merged: legacy wraps predate the `k` tag, so
 * a single filter either misses them or drops the discriminator and returns
 * every 1059 on the relay.
 */
export function invitationInboxFilters(params: {
  pubkeys: string[];
  wrapKind: number;
  wrapType: number;
  includeLegacy: boolean;
  since?: number;
  until?: number;
  limit?: number;
}): Filter[] {
  const window = {
    ...(params.since !== undefined && { since: params.since }),
    ...(params.until !== undefined && { until: params.until }),
    ...(params.limit !== undefined && { limit: params.limit }),
  };

  const filters: Filter[] = [
    {
      kinds: [params.wrapKind],
      "#p": params.pubkeys,
      "#k": [String(params.wrapType)],
      ...window,
    },
  ];
  if (params.includeLegacy) {
    filters.push({ kinds: [params.wrapType], "#p": params.pubkeys, ...window });
  }
  return filters;
}

export const INVITATION_RUMOR_KINDS: readonly number[] = [
  CALENDAR_KINDS.rumor,
  CALENDAR_KINDS.legacyInvitationRumor,
];
