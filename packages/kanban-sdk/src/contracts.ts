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
  /**
   * Gift-wrap kind for invitations. `1053` by default, matching NIP-52E.
   *
   * NIP-59's relay-side protection ("serve kind 1059 only to the p-tagged
   * recipient") is written for 1059 specifically, so 1053 gets none of it: anyone
   * can subscribe to `{"kinds":[1053]}` and enumerate who is being invited to
   * private boards. Kept for consistency with the shipped calendar, which has the
   * same leak; configurable so switching to 1059 is one line. Doc 07 §A6.
   */
  wrapKind: number;
  wrapTimestamps?: "jittered" | "real";
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

export class ViewKeyRequiredError extends Error {
  constructor(coordinate: string) {
    super(
      `No view key for ${coordinate}. Private boards are only readable with their view key — ` +
        `pass one, or link the board into a board list so it can be recovered.`,
    );
    this.name = "ViewKeyRequiredError";
  }
}

export class NotBoardOwnerError extends Error {
  constructor(pubkey: string, coordinate: string) {
    super(
      `${pubkey} is not the author of ${coordinate}. Board events are addressable and ` +
        `single-owner (doc 05 §7): only the author can rename or re-column a board.`,
    );
    this.name = "NotBoardOwnerError";
  }
}

export class InvitationVerificationError extends Error {
  constructor(reason: string) {
    super(`Rejected an invitation: ${reason}`);
    this.name = "InvitationVerificationError";
  }
}
