import { dedupeKey, isFeedRoot, relatesTo, roleOf, getKindDef, registerKind } from "./kinds";
import { resolveAuthors, buildFilters, scopeHasInput, Scope } from "./scope";
import { assembleFeed } from "./feed";
import { makeEvent } from "../localRelay/testkit";

describe("kind registry", () => {
  it("dedupes plain events by id, addressable by replaceable key", () => {
    const note = makeEvent({ id: "n".repeat(64), kind: 1 });
    expect(dedupeKey(note)).toBe("n".repeat(64));

    const article = makeEvent({ kind: 30023, pubkey: "p".repeat(64), tags: [["d", "slug"]] });
    expect(dedupeKey(article)).toBe(`30023:${"p".repeat(64)}:slug`);
  });

  it("treats notes with an e-tag as non-root (replies)", () => {
    expect(isFeedRoot(makeEvent({ kind: 1 }))).toBe(true);
    expect(isFeedRoot(makeEvent({ kind: 1, tags: [["e", "parent"]] }))).toBe(false);
    expect(isFeedRoot(makeEvent({ kind: 30023 }))).toBe(true);
  });

  it("knows roles and relations", () => {
    expect(roleOf(1)).toBe("note");
    expect(roleOf(6)).toBe("repost");
    expect(roleOf(9999)).toBe("other");
    expect(relatesTo(makeEvent({ kind: 6, tags: [["e", "orig"]] }))).toBe("orig");
    expect(isFeedRoot(makeEvent({ kind: 6, tags: [["e", "orig"]] }))).toBe(false);
    // reactions (7) and responses (1018/1070) are never feed roots
    expect(isFeedRoot(makeEvent({ kind: 7, tags: [["e", "liked"]] }))).toBe(false);
    expect(isFeedRoot(makeEvent({ kind: 1018, tags: [["e", "poll"]] }))).toBe(false);
    expect(isFeedRoot(makeEvent({ kind: 1070, tags: [["e", "poll"]] }))).toBe(false);
    expect(relatesTo(makeEvent({ kind: 1018, tags: [["e", "poll"]] }))).toBe("poll");
  });

  it("exposes raw defs via getKindDef and honours a custom dedupeKey", () => {
    expect(getKindDef(1)?.role).toBe("note");
    expect(getKindDef(99999)).toBeUndefined();

    registerKind(49999, { role: "other", dedupeKey: () => "fixed" });
    expect(dedupeKey(makeEvent({ kind: 49999 }))).toBe("fixed");
  });
});

describe("scope", () => {
  const user = { pubkey: "me", follows: ["a", "b"], webOfTrust: new Set(["a", "b", "c"]) };

  it("resolves author sets and flags non-author scopes", () => {
    expect(resolveAuthors({ type: "following" }, user)).toEqual(["a", "b"]);
    expect(resolveAuthors({ type: "network" }, user)).toEqual(["a", "b", "c"]);
    expect(resolveAuthors({ type: "author", pubkey: "x" }, user)).toEqual(["x"]);
    expect(resolveAuthors({ type: "thread", rootId: "r" }, user)).toBeNull();
  });

  it("falls back to empty author sets when follows / web-of-trust are absent", () => {
    expect(resolveAuthors({ type: "following" }, {})).toEqual([]);
    expect(resolveAuthors({ type: "network" }, {})).toEqual([]);
  });

  it("builds an author-less filter for the global scope, carrying the window", () => {
    expect(buildFilters([1], { type: "global" }, {}, { since: 10, until: 20, limit: 5 })).toEqual([
      { kinds: [1], since: 10, until: 20, limit: 5 },
    ]);
  });

  it("builds author filters for author scopes", () => {
    const filters = buildFilters([1, 1068], { type: "following" }, user, { limit: 20 });
    expect(filters).toEqual([{ kinds: [1, 1068], limit: 20, authors: ["a", "b"] }]);
  });

  it("returns no filters when an author scope has no input", () => {
    expect(buildFilters([1], { type: "following" }, { follows: [] })).toEqual([]);
  });

  it("builds tag filters for thread and mentions", () => {
    const thread = buildFilters([1], { type: "thread", rootId: "root" }, user);
    expect(thread).toEqual([
      { kinds: [1], ids: ["root"] },
      { kinds: [1], "#e": ["root"] },
    ]);
    const mentions = buildFilters([1, 7], { type: "mentions", pubkey: "me" }, user);
    expect(mentions).toEqual([{ kinds: [1, 7], "#p": ["me"] }]);
  });

  it("scopeHasInput gates empty feeds", () => {
    expect(scopeHasInput({ type: "following" }, { follows: [] })).toBe(false);
    expect(scopeHasInput({ type: "following" }, {})).toBe(false); // follows absent
    expect(scopeHasInput({ type: "network" }, user)).toBe(true);
    expect(scopeHasInput({ type: "network" }, {})).toBe(false); // web-of-trust absent
    expect(scopeHasInput({ type: "global" } as Scope, {})).toBe(true);
  });
});

describe("assembleFeed", () => {
  it("dedupes, drops replies, and sorts newest-first", () => {
    const events = [
      makeEvent({ id: "a".repeat(64), kind: 1, created_at: 100 }),
      makeEvent({ id: "b".repeat(64), kind: 1, created_at: 300 }),
      makeEvent({ id: "r".repeat(64), kind: 1, created_at: 250, tags: [["e", "x"]] }), // reply
    ];
    const feed = assembleFeed(events);
    expect(feed.map((e) => e.id)).toEqual(["b".repeat(64), "a".repeat(64)]);
  });

  it("keeps the newest version of an addressable event", () => {
    const old = makeEvent({ kind: 30023, pubkey: "p".repeat(64), created_at: 100, tags: [["d", "x"]] });
    const fresh = makeEvent({ kind: 30023, pubkey: "p".repeat(64), created_at: 200, tags: [["d", "x"]] });
    const feed = assembleFeed([old, fresh], { feedRootsOnly: false });
    expect(feed).toHaveLength(1);
    expect(feed[0].created_at).toBe(200);
  });
});
