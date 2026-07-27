import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { normalizeRelayList, normalizeRelayUrl, parseRelayList } from "./relays";

describe("normalizeRelayUrl", () => {
  it("appends a trailing slash", () => {
    expect(normalizeRelayUrl("wss://relay.example")).toBe("wss://relay.example/");
  });

  it("lowercases the host and keeps the path", () => {
    expect(normalizeRelayUrl("wss://Relay.Example/Inbox")).toBe("wss://relay.example/Inbox");
  });

  it("leaves an already-normal url alone", () => {
    expect(normalizeRelayUrl("wss://relay.example/")).toBe("wss://relay.example/");
  });

  it("returns the input unchanged when it is not a url", () => {
    expect(normalizeRelayUrl("not a url")).toBe("not a url");
  });
});

describe("normalizeRelayList", () => {
  it("dedupes after normalization and preserves order", () => {
    expect(normalizeRelayList(["wss://a.example", "wss://A.example/", "wss://b.example"])).toEqual([
      "wss://a.example/",
      "wss://b.example/",
    ]);
  });
});

describe("parseRelayList", () => {
  function relayList(tags: string[][]): Event {
    return {
      id: "r1",
      pubkey: "a".repeat(64),
      created_at: 1,
      kind: 10002,
      tags,
      content: "",
      sig: "",
    } as Event;
  }

  it("splits read and write markers", () => {
    const parsed = parseRelayList(
      relayList([
        ["r", "wss://in.example", "read"],
        ["r", "wss://out.example", "write"],
      ]),
    );
    expect(parsed.read).toEqual(["wss://in.example/"]);
    expect(parsed.write).toEqual(["wss://out.example/"]);
  });

  it("treats an unmarked relay as both read and write", () => {
    const parsed = parseRelayList(relayList([["r", "wss://both.example"]]));
    expect(parsed.read).toEqual(["wss://both.example/"]);
    expect(parsed.write).toEqual(["wss://both.example/"]);
  });

  it("returns empty lists for an empty event", () => {
    const parsed = parseRelayList(relayList([]));
    expect(parsed.read).toEqual([]);
    expect(parsed.write).toEqual([]);
  });
});
