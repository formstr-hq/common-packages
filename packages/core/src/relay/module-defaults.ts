/**
 * Per-module default relays.
 * Picked from each upstream module's hardcoded list, deduplicated.
 * Used only when a module wants narrower defaults than RelayManager.getReadRelays().
 */
export const MODULE_DEFAULT_RELAYS = {
  forms: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.nostr.wirednet.jp",
    "wss://nostr-01.yakihonne.com",
    "wss://relay.snort.social",
    "wss://relay.nostr.band",
    "wss://nostr21.com",
  ],
  // Union of the super-app's original set and calendar.formstr.app's hardcoded
  // relays, so events published here land on every relay the standalone reads
  // (and vice-versa) — required for cross-app calendar sync.
  calendar: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://nostr-pub.wellorder.net",
    "wss://nostr.mom",
    "wss://relay.nostr.wirednet.jp",
    "wss://nostr-01.yakihonne.com",
    "wss://relay.snort.social",
    "wss://nostr21.com",
  ],
  // MUST stay a superset of @formstr/kanban-sdk's DEFAULT_RELAYS
  // (relay.damus.io, nos.lol, relay.primal.net). Narrowing below those three
  // silently breaks interop with kanbanstr.com — boards published here stop
  // appearing there, and no local test catches it.
  kanban: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.nostr.band",
  ],
  // Pages and Polls have no UI in the web app any more, but the agent still
  // implements them for the MCP server — these are protocol relays, not app
  // navigation, so they stay.
  pages: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
  ],
  polls: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
    "wss://relay.nostr.wirednet.jp",
    "wss://nostr-01.yakihonne.com",
    "wss://nostr21.com",
  ],
  drive: [
    "wss://relay.formstr.app",
    "wss://relay.damus.io",
    "wss://relay.nostr.band",
    "wss://nos.lol",
  ],
  // Mail reads kind-1059 gift wraps p-tagged to the user. These default inbox
  // relays mirror @formstr/mailstr-sdk's DEFAULT_INBOX_RELAYS (the bootstrap
  // fallbacks the reference reader observes) so mail sent by the standalone
  // client is found here too. Delivery actually targets the recipient's
  // kind-10050 list; these are where we look when building our own.
  mail: [
    "wss://relay.formstr.app",
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
  ],
} as const;

export type ModuleName = keyof typeof MODULE_DEFAULT_RELAYS;
