import { describe, expect, it } from "vitest";
import type { Event } from "nostr-tools";

import { newestByDTag, nextCreatedAt, supersedes } from "./dedupe";

function evt(id: string, createdAt: number, dTag = "card1"): Event {
  return {
    id,
    created_at: createdAt,
    kind: 30302,
    pubkey: "a".repeat(64),
    tags: [["d", dTag]],
    content: "",
    sig: "",
  } as Event;
}

describe("supersedes", () => {
  it("prefers the newer created_at", () => {
    expect(supersedes(evt("bbb", 200), evt("aaa", 100))).toBe(true);
    expect(supersedes(evt("aaa", 100), evt("bbb", 200))).toBe(false);
  });

  it("breaks created_at ties by LOWEST id, as relays do", () => {
    expect(supersedes(evt("aaa", 100), evt("bbb", 100))).toBe(true);
    expect(supersedes(evt("bbb", 100), evt("aaa", 100))).toBe(false);
  });

  it("does not supersede itself", () => {
    expect(supersedes(evt("aaa", 100), evt("aaa", 100))).toBe(false);
  });
});

describe("newestByDTag", () => {
  it("keeps one event per d tag", () => {
    const resolved = newestByDTag([
      evt("aaa", 100, "card1"),
      evt("bbb", 200, "card1"),
      evt("ccc", 150, "card2"),
    ]);
    expect(resolved.size).toBe(2);
    expect(resolved.get("card1")?.id).toBe("bbb");
    expect(resolved.get("card2")?.id).toBe("ccc");
  });

  it("resolves ties independently of iteration order", () => {
    const forward = newestByDTag([evt("bbb", 100), evt("aaa", 100)]);
    const reverse = newestByDTag([evt("aaa", 100), evt("bbb", 100)]);
    expect(forward.get("card1")?.id).toBe("aaa");
    expect(reverse.get("card1")?.id).toBe("aaa");
  });
});

describe("nextCreatedAt", () => {
  it("returns now when there is no previous version", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(nextCreatedAt()).toBeGreaterThanOrEqual(now);
  });

  it("forces strictly-increasing timestamps within the same second", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(nextCreatedAt(now)).toBe(now + 1);
    expect(nextCreatedAt(now + 500)).toBe(now + 501);
  });
});
