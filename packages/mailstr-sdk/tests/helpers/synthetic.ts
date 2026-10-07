import {
  type Event,
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip44,
} from "nostr-tools";
import { KIND_GIFTWRAP, KIND_SEAL } from "../../src/index.js";
import type { Rumor } from "../../src/types.js";

/**
 * Synthetic wrap-chain builders for tests. Keys are throwaway per test
 * (generateSecretKey) — never a real identity.
 */

export function makeKeypair(): { secretKey: Uint8Array; pubkey: string } {
  const secretKey = generateSecretKey();
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

export interface RumorParams {
  senderSk: Uint8Array;
  recipientPk: string;
  kind?: number;
  content?: string;
  extraTags?: string[][];
  createdAt?: number;
}

/** Build an unsigned rumor with a computed id, like nail's `buildRumor`. */
export function makeRumor(p: RumorParams): Rumor {
  const rumor = {
    kind: p.kind ?? 1301,
    pubkey: getPublicKey(p.senderSk),
    created_at: p.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [["p", p.recipientPk], ...(p.extraTags ?? [])],
    content: p.content ?? "",
  };
  return { ...rumor, id: getEventHash(rumor) };
}

export interface SealOverrides {
  kind?: number;
  /** Replaces the sealed plaintext (default JSON.stringify(rumor)). */
  content?: string;
  createdAt?: number;
}

/** Seal a rumor: kind-13 event, NIP-44-encrypted rumor JSON signed by senderSk. */
export function sealRumor(
  rumor: Rumor,
  senderSk: Uint8Array,
  recipientPk: string,
  o: SealOverrides = {},
): Event {
  const plaintext = o.content ?? JSON.stringify(rumor);
  return finalizeEvent(
    {
      kind: o.kind ?? KIND_SEAL,
      created_at: o.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [],
      content: nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(senderSk, recipientPk),
      ),
    },
    senderSk,
  );
}

export interface WrapOverrides {
  kind?: number;
  /** Replaces the wrapped plaintext (default JSON.stringify(seal)). */
  content?: string;
  tags?: string[][];
  createdAt?: number;
}

/** Gift-wrap a seal: kind-1059 event, NIP-44-encrypted seal JSON signed by wrapSk. */
export function wrapSeal(
  seal: Event,
  recipientPk: string,
  wrapSk: Uint8Array,
  o: WrapOverrides = {},
): Event {
  const plaintext = o.content ?? JSON.stringify(seal);
  return finalizeEvent(
    {
      kind: o.kind ?? KIND_GIFTWRAP,
      created_at: o.createdAt ?? Math.floor(Date.now() / 1000),
      tags: o.tags ?? [["p", recipientPk], ["k", "1301"]],
      content: nip44.v2.encrypt(
        plaintext,
        nip44.v2.utils.getConversationKey(wrapSk, recipientPk),
      ),
    },
    wrapSk,
  );
}

/** Full valid wrap→seal→rumor chain for one recipient. */
export function wrapChain(
  rumorParams: RumorParams,
  io: { recipientSk: Uint8Array; recipientPk?: string; wrapSk?: Uint8Array },
): { wrap: Event; seal: Event; rumor: Rumor; wrapSk: Uint8Array; recipientPk: string } {
  const recipientPk = io.recipientPk ?? getPublicKey(io.recipientSk);
  const rumor = makeRumor({ ...rumorParams, recipientPk });
  const seal = sealRumor(rumor, rumorParams.senderSk, recipientPk);
  const wrapSk = io.wrapSk ?? generateSecretKey();
  const wrap = wrapSeal(seal, recipientPk, wrapSk);
  return { wrap, seal, rumor, wrapSk, recipientPk };
}

/** Re-sign a rumor-shaped object after tampering (keeps the id consistent). */
export function reserializeRumor(r: Rumor): string {
  return JSON.stringify(r);
}