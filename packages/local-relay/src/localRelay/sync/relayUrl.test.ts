import { normalizeRelayUrl, normalizeRelays } from "./relayUrl";
import { RelayPool } from "./RelayPool";
import { fakeSocketFactory } from "../testkit";

describe("normalizeRelayUrl", () => {
  it.each([
    ["wss://relay.damus.io/", "wss://relay.damus.io"],
    ["wss://relay.damus.io", "wss://relay.damus.io"],
    ["WSS://Relay.Damus.IO/", "wss://relay.damus.io"],
    ["wss://nos.lol:443/", "wss://nos.lol"],
    ["ws://localhost:7777/", "ws://localhost:7777"],
    ["wss://relay.primal.net/v1", "wss://relay.primal.net/v1"],
    ["wss://relay.primal.net/v1/", "wss://relay.primal.net/v1"],
    ["  wss://nostr.wine  ", "wss://nostr.wine"],
    ["not a url", "not a url"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeRelayUrl(input)).toBe(expected);
  });

  it("de-duplicates spelling variants, keeping first-seen order", () => {
    expect(normalizeRelays(["wss://b/", "wss://a", "wss://B", "wss://a/"])).toEqual(["wss://b", "wss://a"]);
  });
});

describe("RelayPool relay URL spelling", () => {
  it("opens one socket for `wss://x` and `wss://x/`", () => {
    const f = fakeSocketFactory();
    const pool = new RelayPool(f.factory);
    pool.subscribe(["wss://relay.damus.io/"], [{ kinds: [1] }], { onEvent: () => {} });
    pool.subscribe(["wss://relay.damus.io"], [{ kinds: [2] }], { onEvent: () => {} });
    expect(f.count("wss://relay.damus.io")).toBe(1);
    expect(f.count("wss://relay.damus.io/")).toBe(0);
  });
});
