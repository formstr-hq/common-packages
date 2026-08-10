import { describe, expect, it } from "vitest";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { Event } from "nostr-tools";

import { FakeRuntime } from "../../test/helpers";
import { CALENDAR_KINDS } from "../kinds";
import { dedupeById, newestByCoordinate, supersedes } from "./dedupe";
import { buildDeletionTags, fetchDeletions, indexDeletions, isDeleted } from "./deletions";
import {
  buildRelayListTags,
  fetchRelayLists,
  normalizeRelayList,
  normalizeRelayUrl,
  outboxRelaysFor,
  parseRelayListEvent,
} from "./relays";

const sk = generateSecretKey();
const PUBKEY = getPublicKey(sk);

function signed(over: Partial<Event> & { kind: number }): Event {
  return finalizeEvent(
    {
      kind: over.kind,
      created_at: over.created_at ?? 1_800_000_000,
      tags: over.tags ?? [],
      content: over.content ?? "",
    },
    sk,
  );
}

describe("supersedes", () => {
  it("prefers the newer version", () => {
    const older = signed({ kind: 32678, created_at: 100 });
    const newer = signed({ kind: 32678, created_at: 101, content: "x" });
    expect(supersedes(newer, older)).toBe(true);
    expect(supersedes(older, newer)).toBe(false);
  });

  it("breaks a same-second tie by lowest id, as NIP-01 does", () => {
    // This is exactly why every republish uses nextCreatedAt: without it an
    // edit made in the same second as the version it replaces can lose.
    const a = signed({ kind: 32678, created_at: 100, content: "a" });
    const b = signed({ kind: 32678, created_at: 100, content: "b" });
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    expect(supersedes(low, high)).toBe(true);
    expect(supersedes(high, low)).toBe(false);
  });

  it("accepts anything over nothing", () => {
    expect(supersedes(signed({ kind: 1 }), undefined)).toBe(true);
  });
});

describe("newestByCoordinate", () => {
  it("keeps one winner per kind:pubkey:d", () => {
    const older = signed({ kind: 32678, created_at: 100, tags: [["d", "x"]] });
    const newer = signed({ kind: 32678, created_at: 200, tags: [["d", "x"]] });
    const other = signed({ kind: 32678, created_at: 150, tags: [["d", "y"]] });

    const winners = newestByCoordinate([newer, older, other]);
    expect(winners.size).toBe(2);
    expect(winners.get(`32678:${PUBKEY}:x`)?.id).toBe(newer.id);
  });
});

describe("dedupeById", () => {
  it("keeps the first copy of a repeated event", () => {
    const event = signed({ kind: 1 });
    expect(dedupeById([event, event])).toHaveLength(1);
  });
});

describe("relay URLs", () => {
  it("treats a trailing slash and a case-different host as the same relay", () => {
    expect(normalizeRelayUrl("wss://Nos.LOL/")).toBe("wss://nos.lol");
  });

  it("dedupes while preserving order", () => {
    expect(normalizeRelayList(["wss://a", undefined, "wss://a/", "wss://b"])).toEqual([
      "wss://a",
      "wss://b",
    ]);
  });

  it("leaves an unparseable value alone rather than dropping it", () => {
    expect(normalizeRelayUrl("not a url/")).toBe("not a url");
  });
});

describe("NIP-65 relay lists", () => {
  it("reads r rows", () => {
    const event = signed({ kind: CALENDAR_KINDS.relayList, tags: [["r", "wss://a"], ["x", "y"]] });
    expect(parseRelayListEvent(event)).toEqual(["wss://a"]);
  });

  it("writes r rows", () => {
    expect(buildRelayListTags(["wss://a/", "wss://a"])).toEqual([["r", "wss://a"]]);
  });

  it("keeps only each author's newest list", async () => {
    const runtime = new FakeRuntime();
    runtime.seed(
      signed({ kind: CALENDAR_KINDS.relayList, created_at: 100, tags: [["r", "wss://old"]] }),
      signed({ kind: CALENDAR_KINDS.relayList, created_at: 200, tags: [["r", "wss://new"]] }),
    );
    const lists = await fetchRelayLists(runtime, [], [PUBKEY]);
    expect(lists.get(PUBKEY)).toEqual(["wss://new"]);
  });

  it("omits authors with no list rather than mapping them to an empty array", async () => {
    const runtime = new FakeRuntime();
    expect((await fetchRelayLists(runtime, [], [PUBKEY])).has(PUBKEY)).toBe(false);
  });

  it("unions configured relays with each recipient's own", () => {
    const recipients = new Map([["alice", ["wss://alice"]], ["bob", ["wss://bob", "wss://a"]]]);
    expect(outboxRelaysFor(["wss://a"], recipients, ["alice", "bob"])).toEqual([
      "wss://a",
      "wss://alice",
      "wss://bob",
    ]);
  });
});

describe("deletions", () => {
  it("indexes both e and a targets", () => {
    const index = indexDeletions([
      signed({ kind: 5, tags: [["e", "id1"], ["a", "32678:pk:d1"], ["k", "32678"]] }),
    ]);
    expect(isDeleted(index, { id: "id1" })).toBe(true);
    expect(isDeleted(index, { coordinate: "32678:pk:d1" })).toBe(true);
    expect(isDeleted(index, { id: "other" })).toBe(false);
  });

  it("ignores events that are not deletions", () => {
    const index = indexDeletions([signed({ kind: 1, tags: [["e", "id1"]] })]);
    expect(isDeleted(index, { id: "id1" })).toBe(false);
  });

  it("fetches only the caller's own deletions", async () => {
    const runtime = new FakeRuntime();
    const strangerKey = generateSecretKey();
    runtime.seed(
      signed({ kind: 5, tags: [["e", "mine"]] }),
      finalizeEvent(
        { kind: 5, created_at: 1_800_000_000, tags: [["e", "theirs"]], content: "" },
        strangerKey,
      ),
    );
    const index = await fetchDeletions(runtime, [], PUBKEY);
    expect(isDeleted(index, { id: "mine" })).toBe(true);
    // A stranger's kind 5 is not authoritative over your view — otherwise
    // anyone could hide events from you.
    expect(isDeleted(index, { id: "theirs" })).toBe(false);
  });

  it("builds e, a and k rows", () => {
    expect(
      buildDeletionTags({ eventIds: ["id"], coordinates: ["32678:pk:d"], kinds: [32678] }),
    ).toEqual([["e", "id"], ["a", "32678:pk:d"], ["k", "32678"]]);
  });
});
