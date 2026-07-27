import type { Event, EventTemplate, Filter } from "nostr-tools";

/**
 * Structural signer contract, deliberately identical to `@formstr/calendar-sdk`'s
 * `CalendarSigner` so one signer object satisfies every formstr SDK.
 * nip44 methods are unused on the public path but required so a single signer
 * carries through to Plan 2 without a second contract.
 */
export interface KanbanSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

export interface SubscriptionHandle {
  unsub(): void;
}

/** Every byte of network I/O in the SDK goes through this. */
export interface NostrRuntime {
  querySync(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]>;
  subscribe(
    relays: string[],
    filters: Filter[],
    options?: { onEvent?: (event: Event) => void; onEose?: () => void },
  ): SubscriptionHandle;
  publish(relays: string[], event: Event, timeoutMs?: number): Promise<void>;
  dispose?(): void;
}

/** Per-instance context threaded through every service call. */
export interface KanbanCtx {
  /** Resolves the configured signer or throws `SignerRequiredError`. */
  getSigner(): Promise<KanbanSigner>;
  runtime: NostrRuntime;
  relays: string[];
}

export class SignerRequiredError extends Error {
  constructor(operation: string) {
    super(`${operation} requires a signer — construct the SDK with one: new KanbanSDK({ signer })`);
    this.name = "SignerRequiredError";
  }
}

export class BoardNotFoundError extends Error {
  constructor(coordinate: string) {
    super(`Board not found: ${coordinate}`);
    this.name = "BoardNotFoundError";
  }
}

export class NotAMaintainerError extends Error {
  constructor(pubkey: string, coordinate: string) {
    super(`${pubkey} is not a maintainer of ${coordinate}`);
    this.name = "NotAMaintainerError";
  }
}
