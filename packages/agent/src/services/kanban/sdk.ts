import { signerManager, nostrRuntime, relayManager, type NostrSigner } from "@formstr/core";
import { KanbanSDK, type KanbanSigner } from "@formstr/kanban-sdk";

/**
 * `NostrSigner` declares the NIP-44 methods optional; every formstr SDK's signer
 * contract requires them. Narrowing here is honest — a signer without NIP-44
 * cannot read or write a private board — and mirrors `toCalendarSigner` in the
 * calendar service.
 */
export function toKanbanSigner(signer: NostrSigner): KanbanSigner {
  if (!signer.nip44Encrypt || !signer.nip44Decrypt) {
    throw new Error(
      "The active signer does not declare NIP-44 support, which kanban operations require.",
    );
  }
  const { nip44Encrypt, nip44Decrypt } = signer;
  return {
    getPublicKey: () => signer.getPublicKey(),
    signEvent: (event) => signer.signEvent(event),
    nip44Encrypt: (pubkey, plaintext) => nip44Encrypt.call(signer, pubkey, plaintext),
    nip44Decrypt: (pubkey, ciphertext) => nip44Decrypt.call(signer, pubkey, ciphertext),
  };
}

/**
 * The kanban relay set: core's module default, which is kept a superset of the
 * SDK's own `DEFAULT_RELAYS` so a board written here still shows up on
 * kanbanstr.com.
 */
export function kanbanRelays(): string[] {
  return relayManager.getRelaysForModule("kanban");
}

/**
 * One `KanbanSDK` per (signer instance, pubkey, relay set).
 *
 * Same cache-key reasoning as `getCalendarSdk`: the SDK takes a signer
 * *instance*, so a cached instance outlives an account switch unless we key on
 * the pubkey, and `signerManager` hands back a fresh adapter on every unlock —
 * so the exact signer object is part of the key too. The runtime is injected so
 * the SDK shares core's pool and its `dispose()` leaves those sockets alone.
 */
let cached: { signer: NostrSigner; pubkey: string; relayKey: string; sdk: KanbanSDK } | null = null;

export async function getKanbanSdk(): Promise<KanbanSDK> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const relays = kanbanRelays();
  const relayKey = relays.join(",");

  if (
    cached &&
    cached.signer === signer &&
    cached.pubkey === pubkey &&
    cached.relayKey === relayKey
  ) {
    return cached.sdk;
  }

  const sdk = new KanbanSDK({
    signer: toKanbanSigner(signer),
    runtime: nostrRuntime,
    relays,
  });
  cached = { signer, pubkey, relayKey, sdk };
  return sdk;
}

/**
 * A signerless `KanbanSDK` for public reads that must work logged out.
 *
 * `getKanbanSdk()` resolves a signer, and in the app that routes to the login
 * modal. Browsing a public board by link must not depend on that, so it gets its
 * own instance; anything but a public read throws `SignerRequiredError`.
 */
let cachedAnonymous: { relayKey: string; sdk: KanbanSDK } | null = null;

export function getAnonymousKanbanSdk(): KanbanSDK {
  const relays = kanbanRelays();
  const relayKey = relays.join(",");
  if (cachedAnonymous && cachedAnonymous.relayKey === relayKey) return cachedAnonymous.sdk;

  const sdk = new KanbanSDK({ runtime: nostrRuntime, relays });
  cachedAnonymous = { relayKey, sdk };
  return cachedAnonymous.sdk;
}

/** Drops the cached instances. Call on logout, and from tests. */
export function resetKanbanSdk(): void {
  cached = null;
  cachedAnonymous = null;
}
