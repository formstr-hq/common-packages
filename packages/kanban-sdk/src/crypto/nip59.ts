import { finalizeEvent, generateSecretKey, verifyEvent } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import * as nip44 from "nostr-tools/nip44";

import type { KanbanSigner } from "../contracts";

type UnsignedEvent = Omit<Event, "sig">;

/**
 * NIP-59 gift-wrap pipeline, used to deliver a board view key to an invitee.
 *
 * Three layers:
 *   1. Rumor (unsigned) — keeps its REAL created_at; recipients sort on it.
 *   2. Seal (kind 13), NIP-44 encrypted to the recipient, signed by the inviter.
 *   3. Wrap (kind 1059 by default), signed by a fresh ephemeral key.
 *
 * Seal/wrap timestamps default to real, matching the shipped calendar. Pass
 * `{ timestamps: "jittered" }` for NIP-59's anti-correlation recommendation: a
 * random tweak of up to two days INTO THE PAST. Never the future — relays reject
 * far-future events (strfry defaults to a 15-minute ceiling) and publish is
 * best-effort, so the drop would be silent.
 */

export interface WrapOptions {
  timestamps?: "jittered" | "real";
  /**
   * Extra outer tags on the wrap, alongside the mandatory `p`. Everything here
   * is PLAINTEXT on the relay — use it only for what a wrap must be filterable
   * by, such as the `k` type discriminator.
   */
  tags?: string[][];
}

/** Randomize up to two days into the PAST. Past-only; see above. */
function randomizeTimestamp(timestamp: number): number {
  const twoDays = 2 * 24 * 60 * 60;
  return timestamp - Math.floor(Math.random() * twoDays);
}

export function createRumor(event: Partial<EventTemplate> & { kind: number }): UnsignedEvent {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: event.kind,
    created_at: event.created_at ?? now,
    tags: event.tags ?? [],
    content: event.content ?? "",
    pubkey: "", // set by the caller from the signer
    id: "", // unsigned — no id
  } as UnsignedEvent;
}

export async function createSeal(
  rumor: UnsignedEvent,
  signer: KanbanSigner,
  recipientPubkey: string,
  opts: WrapOptions = {},
): Promise<Event> {
  const encrypted = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  const now = Math.floor(Date.now() / 1000);

  return signer.signEvent({
    kind: 13,
    created_at: opts.timestamps === "jittered" ? randomizeTimestamp(now) : now,
    tags: [],
    content: encrypted,
  });
}

export async function createWrap(
  seal: Event,
  recipientPubkey: string,
  wrapKind = 1059,
  opts: WrapOptions = {},
): Promise<Event> {
  // A fresh key per wrap: the outer author must not identify the inviter.
  const ephemeralKey = generateSecretKey();
  const now = Math.floor(Date.now() / 1000);

  const conversationKey = nip44.v2.utils.getConversationKey(ephemeralKey, recipientPubkey);
  const encrypted = nip44.v2.encrypt(JSON.stringify(seal), conversationKey);

  return finalizeEvent(
    {
      kind: wrapKind,
      created_at: opts.timestamps === "jittered" ? randomizeTimestamp(now) : now,
      tags: [["p", recipientPubkey], ...(opts.tags ?? [])],
      content: encrypted,
    },
    ephemeralKey,
  );
}

export async function wrapEvent(
  event: Partial<EventTemplate> & { kind: number },
  signer: KanbanSigner,
  recipientPubkey: string,
  wrapKind = 1059,
  opts: WrapOptions = {},
): Promise<Event> {
  const rumor = createRumor(event);
  rumor.pubkey = await signer.getPublicKey();
  const seal = await createSeal(rumor, signer, recipientPubkey, opts);
  return createWrap(seal, recipientPubkey, wrapKind, opts);
}

/** One seal per recipient — a seal is encrypted to exactly one pubkey. */
export async function wrapManyEvents(
  event: Partial<EventTemplate> & { kind: number },
  signer: KanbanSigner,
  recipientPubkeys: string[],
  wrapKind = 1059,
  opts: WrapOptions = {},
): Promise<Event[]> {
  const rumor = createRumor(event);
  rumor.pubkey = await signer.getPublicKey();

  const wraps: Event[] = [];
  for (const pubkey of recipientPubkeys) {
    // Serial: remote signers (NIP-46) typically reject concurrent requests.
    const seal = await createSeal(rumor, signer, pubkey, opts);
    wraps.push(await createWrap(seal, pubkey, wrapKind, opts));
  }
  return wraps;
}

/**
 * Unwrap and verify. The rumor is unsigned, so its `pubkey` claim is only
 * trustworthy when (a) the seal carrying it verifies and (b) the seal's signer IS
 * the claimed author. Without both, anyone can hand a victim a board key that
 * appears to come from a trusted colleague. Throws on any failed check — callers
 * treat the wrap as garbage.
 */
export async function unwrapEvent(
  wrappedEvent: Event,
  signer: KanbanSigner,
): Promise<UnsignedEvent> {
  const sealJson = await signer.nip44Decrypt(wrappedEvent.pubkey, wrappedEvent.content);
  const seal = JSON.parse(sealJson) as Event;

  if (seal.kind !== 13) {
    throw new Error(`Invalid gift wrap: seal kind ${seal.kind}, expected 13`);
  }
  if (!verifyEvent(seal)) {
    throw new Error("Invalid gift wrap: seal signature verification failed");
  }

  const rumorJson = await signer.nip44Decrypt(seal.pubkey, seal.content);
  const rumor = JSON.parse(rumorJson) as UnsignedEvent;

  if (rumor.pubkey !== seal.pubkey) {
    throw new Error("Invalid gift wrap: rumor pubkey does not match seal signer");
  }

  return rumor;
}
