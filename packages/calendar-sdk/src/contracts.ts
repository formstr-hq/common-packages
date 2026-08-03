import type { Event, EventTemplate, Filter } from "nostr-tools";

/**
 * Structural signer contract, deliberately identical to `@formstr/kanban-sdk`'s
 * `KanbanSigner` and aligned with `@formstr/sdk`'s `FormsSigner`, so one signer
 * object satisfies every formstr SDK.
 *
 * All four methods are required: the calendar protocol cannot do private events,
 * calendar lists or invitations without NIP-44.
 *
 * Producers: `@formstr/signer` (`createSigner` → NIP-07 / NIP-46 / NIP-55), any
 * NIP-07 extension wrapped by the host, or this package's `LocalSigner`. When
 * adapting a class-based signer, bind its methods — see `adapters/signer.ts`.
 */
export interface CalendarSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
  nip44Encrypt(pubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(pubkey: string, ciphertext: string): Promise<string>;
}

export interface SubscriptionHandle {
  unsub(): void;
}

/**
 * Every byte of network I/O in the SDK goes through this. The default is
 * `SimplePoolRuntime`; hosts with their own pool or cache (the super-app's
 * runtime, calendar.formstr.app's local-relay worker) inject theirs instead —
 * see `runtime/localRelay.ts` for the `@formstr/local-relay` adapter.
 */
export interface NostrRuntime {
  /** One-shot query: collect events until EOSE or timeout, deduped by id. */
  querySync(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]>;
  /** Live subscription. */
  subscribe(
    relays: string[],
    filters: Filter[],
    options?: { onEvent?: (event: Event) => void; onEose?: () => void },
  ): SubscriptionHandle;
  /** Best-effort fan-out publish, bounded by `timeoutMs`. */
  publish(relays: string[], event: Event, timeoutMs?: number): Promise<void>;
  /** Release the runtime's resources (relay sockets). Optional for host runtimes. */
  dispose?(): void;
}

/** Per-instance context threaded through every service call. */
export interface CalendarCtx {
  /** Resolves the configured signer or throws `SignerRequiredError`. */
  getSigner(): Promise<CalendarSigner>;
  runtime: NostrRuntime;
  relays: string[];
  /**
   * Wire kind for gift wraps, `1059` by default. Configurable so a host can
   * follow the ecosystem if NIP-59 ever moves, without an SDK release.
   */
  wrapKind: number;
  /**
   * Value of the `["k", …]` discriminator on those wraps, `1052` by default.
   * Doubles as the legacy wire kind on read — docs/protocol.md §6.
   */
  wrapType: number;
  /**
   * Seal/wrap `created_at` mode. `"real"` by default, matching what
   * calendar.formstr.app publishes byte for byte. `"jittered"` applies NIP-59's
   * anti-correlation recommendation.
   */
  wrapTimestamps: "jittered" | "real";
  /** Base URL used to build the share links embedded in invitation rumors. */
  appBaseUrl: string;
  /** Read the legacy pre-NIP-17 wrap kind alongside the current one. */
  readLegacyWraps: boolean;
}

/** Thrown by operations that need a signer when the SDK was built without one. */
export class SignerRequiredError extends Error {
  constructor(operation: string) {
    super(
      `${operation} requires a signer — construct the SDK with one: new CalendarSDK({ signer })`,
    );
    this.name = "SignerRequiredError";
  }
}

/** Thrown when a private event cannot be read because no view key resolved. */
export class ViewKeyRequiredError extends Error {
  constructor(coordinate: string) {
    super(
      `No view key for ${coordinate}. Private events are only readable with their view key — ` +
        `pass one, or link the event into a calendar list so the key can be recovered from its ref.`,
    );
    this.name = "ViewKeyRequiredError";
  }
}

/** Thrown when a gift wrap fails NIP-59 verification — docs/protocol.md §6.3. */
export class GiftWrapVerificationError extends Error {
  constructor(reason: string) {
    super(`Rejected a gift wrap: ${reason}`);
    this.name = "GiftWrapVerificationError";
  }
}

export class CalendarNotFoundError extends Error {
  constructor(calendarId: string) {
    super(`Calendar list not found: ${calendarId}`);
    this.name = "CalendarNotFoundError";
  }
}
