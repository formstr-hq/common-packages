import { finalizeEvent, SimplePool, type Event } from "nostr-tools";
import { KIND_DM_RELAYS, KIND_PROFILE } from "./constants.js";

/**
 * First-run setup, mirroring what the mailstr web client publishes:
 *   - kind 0 profile carrying the `nip05` address, and
 *   - kind 10050 NIP-17 DM relay list (tags `["relay", <url>]`, empty content).
 *
 * Mailstr senders resolve the recipient's delivery relays from kind 10050;
 * without it, mail has nowhere to be delivered even if the claim succeeded.
 */

export const DEFAULT_SETUP_RELAYS = [
  "wss://relay.formstr.app",
  "wss://relay.primal.net",
  "wss://nos.lol",
];

export interface PublishResult {
  relay: string;
  /** True when the relay answered OK. */
  ok: boolean;
  /** The relay's OK reason string, or the error, verbatim. */
  detail: string;
}

export interface SetupEventOutcome {
  eventId: string;
  results: PublishResult[];
}

export interface PublishSetupOptions {
  name: string;
  /** The claimed NIP-05 address, e.g. "irona@mailstr.app". */
  nip05?: string;
  about?: string;
  picture?: string;
  /** Kind-0 profile content merged under the standard fields. */
  profileExtra?: Record<string, unknown>;
  relays?: string[];
  /** Overrides the relay-publishing transport (tests, custom signers/pools). */
  pool?: Pick<SimplePool, "publish">;
}

/**
 * Publish the profile + DM-relay setup events. Relays may reject either
 * event (auth, rate limits); both outcomes are reported per relay instead of
 * throwing, matching the web client's all-settled behavior.
 */
export async function publishSetup(
  secretKey: Uint8Array,
  opts: PublishSetupOptions,
): Promise<{ profile: SetupEventOutcome; dmRelays: SetupEventOutcome }> {
  const relays = opts.relays ?? DEFAULT_SETUP_RELAYS;

  const profile = finalizeEvent(
    {
      kind: KIND_PROFILE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({
        name: opts.name,
        ...(opts.nip05 ? { nip05: opts.nip05 } : {}),
        ...(opts.about ? { about: opts.about } : {}),
        ...(opts.picture ? { picture: opts.picture } : {}),
        ...opts.profileExtra,
      }),
    },
    secretKey,
  );

  const dmRelays = finalizeEvent(
    {
      kind: KIND_DM_RELAYS,
      created_at: Math.floor(Date.now() / 1000),
      tags: relays.map((r) => ["relay", r]),
      content: "",
    },
    secretKey,
  );

  // One pool for both publishes: reuses relay connections instead of
  // dialing every relay twice.
  const pool = opts.pool ?? new SimplePool();
  const [profileOutcome, dmRelayOutcome] = await Promise.all([
    publishEverywhere(pool, relays, profile),
    publishEverywhere(pool, relays, dmRelays),
  ]);
  return { profile: profileOutcome, dmRelays: dmRelayOutcome };
}

/**
 * Publish one event to all relays. nostr-tools' `pool.publish` returns one
 * promise per relay (in order), resolving to the relay's OK reason string on
 * success and rejecting with the failure — folded into {@link PublishResult}.
 */
async function publishEverywhere(
  pool: Pick<SimplePool, "publish">,
  relays: string[],
  event: Event,
): Promise<SetupEventOutcome> {
  const settled = await Promise.allSettled(pool.publish(relays, event));
  return {
    eventId: event.id,
    results: settled.map((s, i) => {
      const relay = relays[i] ?? "";
      return s.status === "fulfilled"
        ? { relay, ok: true, detail: s.value ?? "" }
        : { relay, ok: false, detail: String(s.reason) };
    }),
  };
}