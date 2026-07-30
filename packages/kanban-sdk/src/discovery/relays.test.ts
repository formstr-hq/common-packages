import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime } from "../../test/helpers";
import type { Event } from "nostr-tools";

import {
  fetchRelayListsForPubkeys,
  getInvitationInboxRelays,
  normalizeRelayList,
  normalizeRelayUrl,
  parseRelayList,
} from "./relays";

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

// ── Outbox routing (Plan 3) ─────────────────────────────

function relayListEvent(secret: Uint8Array, tags: string[][]) {
  return finalizeEvent(
    { kind: 10002, created_at: Math.floor(Date.now() / 1000), tags, content: "" },
    secret,
  );
}

describe("fetchRelayListsForPubkeys", () => {
  it("returns each pubkey's read relays", async () => {
    const runtime = new FakeRuntime();
    const bob = generateSecretKey();
    runtime.seed(
      relayListEvent(bob, [
        ["r", "wss://bob.example/", "read"],
        ["r", "wss://bob-write.example/", "write"],
      ]),
    );

    const lists = await fetchRelayListsForPubkeys(runtime, ["wss://test.relay/"], [
      getPublicKey(bob),
    ]);
    expect(lists.get(getPublicKey(bob))).toEqual(["wss://bob.example/"]);
  });

  it("treats an unmarked r tag as both read and write", async () => {
    const runtime = new FakeRuntime();
    const bob = generateSecretKey();
    runtime.seed(relayListEvent(bob, [["r", "wss://both.example/"]]));

    const lists = await fetchRelayListsForPubkeys(runtime, [], [getPublicKey(bob)]);
    expect(lists.get(getPublicKey(bob))).toEqual(["wss://both.example/"]);
  });

  it("keeps only the newest list per author", async () => {
    const runtime = new FakeRuntime();
    const bob = generateSecretKey();
    runtime.seed(
      finalizeEvent(
        { kind: 10002, created_at: 100, tags: [["r", "wss://old.example/"]], content: "" },
        bob,
      ),
    );
    runtime.seed(
      finalizeEvent(
        { kind: 10002, created_at: 200, tags: [["r", "wss://new.example/"]], content: "" },
        bob,
      ),
    );

    const lists = await fetchRelayListsForPubkeys(runtime, [], [getPublicKey(bob)]);
    expect(lists.get(getPublicKey(bob))).toEqual(["wss://new.example/"]);
  });

  it("omits an author with no relay list rather than inventing one", async () => {
    const lists = await fetchRelayListsForPubkeys(new FakeRuntime(), [], [
      getPublicKey(generateSecretKey()),
    ]);
    expect(lists.size).toBe(0);
  });

  it("short-circuits on an empty pubkey list", async () => {
    expect((await fetchRelayListsForPubkeys(new FakeRuntime(), [], [])).size).toBe(0);
  });
});

describe("getInvitationInboxRelays", () => {
  it("unions the configured relays with the user's own read relays", async () => {
    const runtime = new FakeRuntime();
    const me = generateSecretKey();
    runtime.seed(relayListEvent(me, [["r", "wss://mine.example/", "read"]]));

    const inbox = await getInvitationInboxRelays(
      runtime,
      ["wss://configured.example/"],
      getPublicKey(me),
    );
    expect(inbox).toEqual(["wss://configured.example/", "wss://mine.example/"]);
  });

  it("falls back to the configured relays when the user has no list", async () => {
    const inbox = await getInvitationInboxRelays(new FakeRuntime(), ["wss://a/"], "ff".repeat(32));
    expect(inbox).toEqual(["wss://a/"]);
  });
});
