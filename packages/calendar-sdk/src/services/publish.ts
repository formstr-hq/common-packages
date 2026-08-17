import { getEventHash } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";

import type { CalendarCtx } from "../contracts";

/**
 * Sign-and-publish plumbing shared by every service.
 */

/**
 * Signs, then re-stamps the id from the fields that were actually signed.
 *
 * Upstream does the same (`core.ts:12-17`): some signers return an id computed
 * differently than the wire format expects, and a wrong id makes the event
 * unfetchable by `ids` and undeletable by `e` tag.
 */
export async function signEvent(ctx: CalendarCtx, template: EventTemplate): Promise<Event> {
  const signer = await ctx.getSigner();
  const signed = await signer.signEvent(template);
  signed.id = getEventHash(signed);
  return signed;
}

/**
 * Publishes and reports where it went.
 *
 * `NostrRuntime.publish` is best-effort fan-out with no per-relay outcome, so
 * the returned hint is "the first relay we published to", not "the first relay
 * that accepted". That is what a relay hint is for — a place to look first —
 * and treating it as a guarantee is what would be wrong.
 */
export async function publishEvent(
  ctx: CalendarCtx,
  event: Event,
  relays?: string[],
): Promise<{ event: Event; relayHint: string; relays: string[] }> {
  const targets = relays && relays.length > 0 ? relays : ctx.relays;
  await ctx.runtime.publish(targets, event);
  return { event, relayHint: targets[0] ?? "", relays: targets };
}

export async function signAndPublish(
  ctx: CalendarCtx,
  template: EventTemplate,
  relays?: string[],
): Promise<{ event: Event; relayHint: string; relays: string[] }> {
  return publishEvent(ctx, await signEvent(ctx, template), relays);
}
