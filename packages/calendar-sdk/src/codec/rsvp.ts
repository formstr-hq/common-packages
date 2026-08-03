import type { Event } from "nostr-tools";

import { RSVPStatus, type RSVPPayload, type RSVPResponse } from "../types";
import { makeDTag } from "./identifiers";

/**
 * RSVP codec — docs/protocol.md §8. Mirrors nostr-calendar's `src/nostr/rsvp.ts`.
 *
 * Private (32069) and public (31925) RSVPs share a deterministic d-tag, so one
 * addressable event holds the latest status per responder per event. They
 * differ in where the comment lives: inside the ciphertext for private,
 * in `content` for public.
 */

/** Deterministic per `(responder, event author, event d-tag)`. */
export function rsvpDTag(
  responderPubkey: string,
  authorPubkey: string,
  eventDTag: string,
): string {
  return makeDTag(`${responderPubkey}:${authorPubkey}:${eventDTag}`);
}

/**
 * Drops an RSVP whose status is not one of the three the protocol defines.
 * `pending` exists in the UI model but is never written, so an event carrying
 * it is either malformed or from a client we do not speak.
 */
export function normalizeRsvpPayload(
  payload: Partial<RSVPPayload> | null | undefined,
): Required<Pick<RSVPPayload, "status">> &
  Pick<RSVPPayload, "suggestedStart" | "suggestedEnd"> & { comment: string } | null {
  if (!payload) return null;
  const { status } = payload;
  if (
    status !== RSVPStatus.accepted &&
    status !== RSVPStatus.declined &&
    status !== RSVPStatus.tentative
  ) {
    return null;
  }

  const suggestedStart =
    payload.suggestedStart !== undefined ? Number(payload.suggestedStart) : undefined;
  const suggestedEnd =
    payload.suggestedEnd !== undefined ? Number(payload.suggestedEnd) : undefined;

  return {
    status,
    suggestedStart: Number.isFinite(suggestedStart) ? suggestedStart : undefined,
    suggestedEnd: Number.isFinite(suggestedEnd) ? suggestedEnd : undefined,
    comment: payload.comment ?? "",
  };
}

/**
 * A relay hint is appended only when present. `["a", coord, ""]` is NOT the
 * same tag as `["a", coord]`, and upstream writes the two-element form.
 */
function aTag(coordinate: string, relayHint?: string): string[] {
  return relayHint ? ["a", coordinate, relayHint] : ["a", coordinate];
}

/** Outer tags of a private RSVP. The payload goes in encrypted `content`. */
export function buildPrivateRsvpTags(params: {
  coordinate: string;
  dTag: string;
  relayHint?: string;
}): string[][] {
  return [aTag(params.coordinate, params.relayHint), ["d", params.dTag]];
}

/** Tags of a public RSVP. The comment goes in `content`, not a tag. */
export function buildPublicRsvpTags(params: {
  coordinate: string;
  dTag: string;
  relayHint?: string;
  payload: RSVPPayload;
}): string[][] {
  const tags: string[][] = [aTag(params.coordinate, params.relayHint), ["status", params.payload.status]];
  if (params.payload.suggestedStart) tags.push(["start", String(params.payload.suggestedStart)]);
  if (params.payload.suggestedEnd) tags.push(["end", String(params.payload.suggestedEnd)]);
  tags.push(["d", params.dTag]);
  return tags;
}

/** Private RSVP event + its decrypted payload → `RSVPResponse`. */
export function parsePrivateRsvp(event: Event, payload: unknown): RSVPResponse | null {
  const eventCoord = event.tags.find((t) => t[0] === "a")?.[1];
  if (!eventCoord) return null;

  const normalized = normalizeRsvpPayload(payload as Partial<RSVPPayload>);
  if (!normalized) return null;

  return {
    pubkey: event.pubkey,
    status: normalized.status,
    suggestedStart: normalized.suggestedStart,
    suggestedEnd: normalized.suggestedEnd,
    comment: normalized.comment,
    createdAt: event.created_at,
    eventCoord,
  };
}

/** Public RSVP event → `RSVPResponse`. Everything is read off plaintext tags. */
export function parsePublicRsvp(event: Event): RSVPResponse | null {
  const eventCoord = event.tags.find((t) => t[0] === "a")?.[1];
  if (!eventCoord) return null;

  const startTag = event.tags.find((t) => t[0] === "start")?.[1];
  const endTag = event.tags.find((t) => t[0] === "end")?.[1];
  const normalized = normalizeRsvpPayload({
    status: event.tags.find((t) => t[0] === "status")?.[1] as RSVPStatus | undefined,
    suggestedStart: startTag ? Number(startTag) : undefined,
    suggestedEnd: endTag ? Number(endTag) : undefined,
    comment: event.content || "",
  });
  if (!normalized) return null;

  return {
    pubkey: event.pubkey,
    status: normalized.status,
    suggestedStart: normalized.suggestedStart,
    suggestedEnd: normalized.suggestedEnd,
    comment: normalized.comment,
    createdAt: event.created_at,
    eventCoord,
  };
}

/**
 * Newest RSVP per responder. A responder's replaceable event should already be
 * unique, but relays hand back older versions during backfill and the caller
 * wants the current answer.
 */
export function latestRsvpPerResponder(responses: readonly RSVPResponse[]): RSVPResponse[] {
  const byResponder = new Map<string, RSVPResponse>();
  for (const response of responses) {
    const existing = byResponder.get(response.pubkey);
    if (!existing || response.createdAt > existing.createdAt) {
      byResponder.set(response.pubkey, response);
    }
  }
  return [...byResponder.values()];
}
