import { SimplePool, type NostrEvent } from "nostr-tools";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.snort.social",
  "wss://purplerelay.com",
];

/**
 * Fetches the latest kind 0 (metadata) event for a given pubkey.
 */
export async function fetchUserProfile(
  pubkey: string,
  relays: string[] = DEFAULT_RELAYS
): Promise<NostrEvent | null> {
  const pool = new SimplePool();
  try {
    const event = await pool.get(relays, {
      kinds: [0],
      authors: [pubkey],
    });
    return event;
  } catch (error) {
    console.error("Failed to fetch user profile:", error);
    return null;
  } finally {
    pool.close(relays);
  }
}

/**
 * Publishes a signed event to the network.
 */
export async function publishEvent(
  event: NostrEvent,
  relays: string[] = DEFAULT_RELAYS
): Promise<void> {
  const pool = new SimplePool();
  try {
    await Promise.any(pool.publish(relays, event));
  } catch (error) {
    console.error("Failed to publish event:", error);
  } finally {
    pool.close(relays);
  }
}
