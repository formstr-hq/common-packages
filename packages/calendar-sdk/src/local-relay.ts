/**
 * `@formstr/calendar-sdk/local-relay` — the optional `@formstr/local-relay`
 * runtime adapter.
 *
 * Kept out of the main entry so importing the SDK never drags in the peer
 * dependency. Usage:
 *
 * ```ts
 * import { dataLayer } from "@formstr/local-relay";
 * import { CalendarSDK } from "@formstr/calendar-sdk";
 * import { LocalRelayRuntime } from "@formstr/calendar-sdk/local-relay";
 *
 * const sdk = new CalendarSDK({ signer, runtime: new LocalRelayRuntime(dataLayer) });
 * ```
 */
export {
  LocalRelayRuntime,
  type LocalRelayDataLayer,
  type LocalRelayRuntimeOptions,
} from "./runtime/localRelay";
