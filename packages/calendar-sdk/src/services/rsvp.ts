import type { Event } from "nostr-tools";

import { CALENDAR_KINDS } from "../kinds";
import { ViewKeyRequiredError, type CalendarCtx } from "../contracts";
import type { RSVPPayload, RSVPResponse } from "../types";
import {
  buildPrivateRsvpTags,
  buildPublicRsvpTags,
  latestRsvpPerResponder,
  parsePrivateRsvp,
  parsePublicRsvp,
  rsvpDTag,
} from "../codec/rsvp";
import { parseCoordinate } from "../codec/identifiers";
import { decodeViewKey } from "../crypto/viewKey";
import { selfDecrypt, selfEncrypt } from "../crypto/nip44";
import { newestByCoordinate } from "../discovery/dedupe";
import { signAndPublish } from "./publish";

/**
 * RSVPs — docs/protocol.md §8.
 *
 * A private RSVP is encrypted under the EVENT's view key, not the responder's
 * own: exactly the set of people who can read the event can read who is
 * coming.
 */

export interface PublishRsvpParams {
  /** `<kind>:<author>:<dTag>` of the event being answered. */
  coordinate: string;
  payload: RSVPPayload;
  /** Required for a private event. */
  viewKey?: string;
  relayHint?: string;
}

export async function publishRsvp(
  ctx: CalendarCtx,
  params: PublishRsvpParams,
): Promise<Event> {
  const parsed = parseCoordinate(params.coordinate);
  if (!parsed) throw new Error(`Not an event coordinate: ${params.coordinate}`);

  const signer = await ctx.getSigner();
  const responderPubkey = await signer.getPublicKey();
  const dTag = rsvpDTag(responderPubkey, parsed.authorPubkey, parsed.dTag);

  if (parsed.kind === CALENDAR_KINDS.publicEvent) {
    const { event } = await signAndPublish(ctx, {
      kind: CALENDAR_KINDS.publicRsvp,
      tags: buildPublicRsvpTags({
        coordinate: params.coordinate,
        dTag,
        relayHint: params.relayHint,
        payload: params.payload,
      }),
      content: params.payload.comment ?? "",
      created_at: Math.floor(Date.now() / 1000),
    });
    return event;
  }

  if (!params.viewKey) throw new ViewKeyRequiredError(params.coordinate);

  const { event } = await signAndPublish(ctx, {
    kind: CALENDAR_KINDS.privateRsvp,
    tags: buildPrivateRsvpTags({
      coordinate: params.coordinate,
      dTag,
      relayHint: params.relayHint,
    }),
    content: selfEncrypt(decodeViewKey(params.viewKey), params.payload),
    // Plain `now`, not nextCreatedAt — parity with upstream (§12.4). An RSVP
    // is one event per responder per event, so a same-second collision would
    // need the same person answering twice in one second.
    created_at: Math.floor(Date.now() / 1000),
  });
  return event;
}

/**
 * Every RSVP for an event, newest answer per responder.
 *
 * The `#a` filter is not trusted on its own: a record whose decoded coordinate
 * does not match what was asked for is dropped, mirroring upstream.
 */
export async function fetchRsvps(
  ctx: CalendarCtx,
  coordinate: string,
  options: { viewKey?: string; relays?: string[] } = {},
): Promise<RSVPResponse[]> {
  const parsed = parseCoordinate(coordinate);
  if (!parsed) return [];

  const isPublic = parsed.kind === CALENDAR_KINDS.publicEvent;
  const relays = options.relays && options.relays.length > 0 ? options.relays : ctx.relays;

  const events = await ctx.runtime.querySync(relays, {
    kinds: [isPublic ? CALENDAR_KINDS.publicRsvp : CALENDAR_KINDS.privateRsvp],
    "#a": [coordinate],
  });

  const responses: RSVPResponse[] = [];
  for (const event of newestByCoordinate(events).values()) {
    const response = isPublic
      ? parsePublicRsvp(event)
      : options.viewKey
        ? parsePrivateRsvp(event, decryptRsvp(event, options.viewKey))
        : null;
    if (!response) continue;
    if (response.eventCoord !== coordinate) continue;
    responses.push(response);
  }

  return latestRsvpPerResponder(responses).sort((a, b) => b.createdAt - a.createdAt);
}

function decryptRsvp(event: Event, viewKey: string): unknown {
  try {
    return selfDecrypt<unknown>(decodeViewKey(viewKey), event.content);
  } catch {
    // Wrong key for this RSVP, or not an RSVP we can read.
    return null;
  }
}
