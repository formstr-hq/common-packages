import { finalizeEvent, generateSecretKey, getEventHash, nip19, verifyEvent } from "nostr-tools";
import type { Event, EventTemplate } from "nostr-tools";
import { getConversationKey, encrypt } from "nostr-tools/nip44";

import { CALENDAR_KINDS } from "../kinds";
import { GiftWrapVerificationError, type CalendarSigner } from "../contracts";

export type Rumor = Omit<Event, "sig">;

/**
 * NIP-59 gift wrap, as nostr-calendar builds it (`src/nostr/crypto.ts` §118-240).
 * Three layers — docs/protocol.md §6:
 *
 *   1. Rumor — unsigned, kind 14 (NIP-17), real `created_at`, sender's pubkey.
 *   2. Seal — kind 13, NIP-44 encrypted to the recipient, signed by the sender.
 *   3. Wrap — kind 1059, encrypted under a fresh ephemeral key that also signs it.
 *
 * Every layer carries a real `created_at`, matching what calendar.formstr.app
 * publishes byte for byte.
 */

export interface WrapOptions {
  /**
   * Extra outer tags on the wrap, alongside the mandatory `p`. Everything here
   * is PLAINTEXT on the relay — use it only for what a wrap must be filterable
   * by, such as the `k` type discriminator.
   */
  tags?: string[][];
  /**
   * Sign the wrap with this key instead of a fresh one. Exists so a caller can
   * mint the key first and embed its nsec in the rumor, letting the recipient
   * delete the wrap later (NIP-09 honours a deletion only from the target's own
   * author). Still one key per wrap — reusing one across recipients makes the
   * wraps linkable to each other.
   */
  ephemeralKey?: Uint8Array;
}

const now = () => Math.floor(Date.now() / 1000);

/**
 * Builds the unsigned rumor and stamps its id. Upstream computes the id here
 * too (`createRumor`), and the id is what a recipient sees as the message's
 * identity — an empty one makes deduplication impossible.
 */
export function createRumor(
  event: Partial<EventTemplate> & { kind?: number },
  pubkey: string,
): Rumor {
  const rumor: Rumor = {
    kind: event.kind ?? CALENDAR_KINDS.rumor,
    created_at: event.created_at ?? now(),
    tags: event.tags ?? [],
    content: event.content ?? "",
    pubkey,
    id: "",
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

export async function createSeal(
  rumor: Rumor,
  signer: CalendarSigner,
  recipientPubkey: string,
  opts: WrapOptions = {},
): Promise<Event> {
  const content = await signer.nip44Encrypt(recipientPubkey, JSON.stringify(rumor));
  return signer.signEvent({
    kind: CALENDAR_KINDS.seal,
    content,
    created_at: now(),
    tags: [],
  });
}

export function createWrap(
  seal: Event,
  recipientPubkey: string,
  opts: WrapOptions = {},
): Event {
  // A fresh key per wrap: the outer author must not identify the sender.
  const ephemeralKey = opts.ephemeralKey ?? generateSecretKey();
  const template: EventTemplate = {
    kind: CALENDAR_KINDS.giftWrap,
    content: encrypt(
      JSON.stringify(seal),
      getConversationKey(ephemeralKey, recipientPubkey),
    ),
    created_at: now(),
    tags: [["p", recipientPubkey], ...(opts.tags ?? [])],
  };
  return finalizeEvent(template, ephemeralKey);
}

/**
 * `event` may be a template or a builder that receives the nsec of the key the
 * wrap will be signed with. The rumor is sealed before the wrap exists, so a
 * caller wanting that nsec *inside* the payload has to be handed it up front —
 * which is exactly how `signing_nsec` gets there.
 */
export async function wrapEvent(
  event:
    | (Partial<EventTemplate> & { kind?: number })
    | ((signingNsec: string) => Partial<EventTemplate> & { kind?: number }),
  signer: CalendarSigner,
  recipientPubkey: string,
  opts: WrapOptions = {},
): Promise<Event> {
  const ephemeralKey = opts.ephemeralKey ?? generateSecretKey();
  const resolved = typeof event === "function" ? event(nip19.nsecEncode(ephemeralKey)) : event;
  const rumor = createRumor(resolved, await signer.getPublicKey());
  const seal = await createSeal(rumor, signer, recipientPubkey, opts);
  return createWrap(seal, recipientPubkey, { ...opts, ephemeralKey });
}

/**
 * Unwraps both layers and verifies them.
 *
 * The outer layer decrypts even though it was *encrypted* with a random
 * ephemeral key: NIP-44 conversation keys are symmetric (ECDH), so given the
 * wrap's `pubkey` the recipient's signer derives the same key the sender used.
 *
 * The rumor is UNSIGNED, so its `pubkey` field is an unverified claim. This
 * checks what upstream does not (docs/protocol.md §6.3): the seal is kind 13,
 * its signature verifies, and the rumor's claimed author IS the seal's signer.
 * Without all three a wrap can be forged to appear to come from anyone — and an
 * invitation is a capability, it hands over the event's view key.
 */
export async function unwrapEvent(wrap: Event, signer: CalendarSigner): Promise<Rumor> {
  let seal: Event;
  try {
    seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as Event;
  } catch (err) {
    throw new GiftWrapVerificationError(
      `seal did not decrypt (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (seal.kind !== CALENDAR_KINDS.seal) {
    throw new GiftWrapVerificationError(`seal kind ${seal.kind}, expected ${CALENDAR_KINDS.seal}`);
  }
  if (!verifyEvent(seal)) {
    throw new GiftWrapVerificationError("seal signature verification failed");
  }

  let rumor: Rumor;
  try {
    rumor = JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as Rumor;
  } catch (err) {
    throw new GiftWrapVerificationError(
      `rumor did not decrypt (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (rumor.pubkey !== seal.pubkey) {
    throw new GiftWrapVerificationError("rumor pubkey does not match the seal signer");
  }
  return rumor;
}

/**
 * NIP-09 deletion of a gift wrap, signed with the wrap's OWN ephemeral key.
 *
 * A recipient cannot delete a wrap with their own signature — NIP-09 honours a
 * deletion only from the target event's author, and that author is a throwaway
 * key. The sender ships that key's nsec inside the encrypted rumor
 * (`signing_nsec`), handing the recipient exactly enough authority to retract
 * the one event addressed to them.
 *
 * Upstream's `buildSelfSignedDeletion` omits the `k` row. We include it: NIP-09
 * says a deletion MUST carry `k`, upstream never reads deletion events (so this
 * cannot desync the two clients), and a relay that enforces the rule would
 * otherwise reject the request and leave dismissal silently broken.
 */
export function buildSelfSignedDeletion(signingNsec: string, eventIds: string[]): Event {
  const decoded = nip19.decode(signingNsec);
  if (decoded.type !== "nsec") {
    throw new Error(`Expected an nsec signing key, got ${decoded.type}`);
  }
  return finalizeEvent(
    {
      kind: CALENDAR_KINDS.deletion,
      content: "",
      created_at: now(),
      tags: [...eventIds.map((id) => ["e", id]), ["k", String(CALENDAR_KINDS.giftWrap)]],
    },
    decoded.data,
  );
}
