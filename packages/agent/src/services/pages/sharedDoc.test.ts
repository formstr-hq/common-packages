import type { Event } from "nostr-tools";
import { describe, it, expect } from "vitest";

import {
  authorSet,
  collabRoom,
  contentTags,
  isOpenRoster,
  MAX_CLOCK_SKEW_SEC,
  parseRootAddress,
  parseRosterPayload,
  rosterDTag,
  rootAddress,
  selectTip,
  type DocRoster,
} from "./sharedDoc";
import { pubkeyFromHex } from "./viewKey";

const VK = "11".repeat(32);

const ev = (id: string, created_at: number, pubkey = "aa"): Event =>
  ({ id, pubkey, kind: 33457, created_at, sig: "s", content: "", tags: [] }) as Event;

describe("address helpers", () => {
  it("round-trips a root address and keeps colons in d", () => {
    const addr = rootAddress("abcd", "33457:x:y");
    expect(addr).toBe("33457:abcd:33457:x:y");
    expect(parseRootAddress(addr)).toEqual({ kind: 33457, owner: "abcd", d: "33457:x:y" });
  });

  it("rosterDTag is the root address", () => {
    expect(rosterDTag("abcd", "d1")).toBe("33457:abcd:d1");
  });

  it("collabRoom is pubkey(viewKey)", () => {
    expect(collabRoom(VK)).toBe(pubkeyFromHex(VK));
  });

  it("contentTags adds the room tag only for a shared doc", () => {
    expect(contentTags("d1")).toEqual([["d", "d1"]]);
    expect(contentTags("d1", VK)).toEqual([["d", "d1"], ["a", collabRoom(VK)]]);
  });

  it("rejects malformed addresses", () => {
    expect(parseRootAddress("no-colon")).toBeNull();
    expect(parseRootAddress("x:y:z")).toBeNull();
  });
});

describe("parseRosterPayload", () => {
  it("normalizes a valid roster and defaults the mode to restricted", () => {
    expect(
      parseRosterPayload(JSON.stringify({ mode: "open", members: [{ pubkey: "a", role: "editor" }] })),
    ).toEqual({
      v: 2,
      mode: "open",
      title: undefined,
      tags: [],
      members: [{ pubkey: "a", role: "editor" }],
    });
  });

  it("drops members with an unknown role and defaults members/tags", () => {
    expect(parseRosterPayload(JSON.stringify({ members: [{ pubkey: "a", role: "nope" }] }))).toEqual(
      { v: 2, mode: "restricted", title: undefined, tags: [], members: [] },
    );
  });

  it("rejects non-object payloads", () => {
    expect(parseRosterPayload("[]")).toBeNull();
    expect(parseRosterPayload("42")).toBeNull();
    expect(parseRosterPayload("not json")).toBeNull();
  });
});

describe("authorSet / isOpenRoster", () => {
  const roster: DocRoster = {
    v: 2,
    mode: "restricted",
    tags: [],
    members: [
      { pubkey: "editor1", role: "editor" },
      { pubkey: "viewer1", role: "viewer" },
    ],
  };

  it("is owner + editors only", () => {
    expect(authorSet("owner", roster).sort()).toEqual(["editor1", "owner"]);
  });

  it("degrades to the owner alone with no roster", () => {
    expect(authorSet("owner", null)).toEqual(["owner"]);
  });

  it("open mode is capability-based", () => {
    expect(isOpenRoster({ ...roster, mode: "open" })).toBe(true);
    expect(isOpenRoster(roster)).toBe(false);
    expect(isOpenRoster(null)).toBe(false);
  });
});

describe("selectTip", () => {
  it("picks the newest and breaks ties by ascending id", () => {
    const now = 1_000_000;
    expect(selectTip([ev("b", 10), ev("a", 20)], now)!.id).toBe("a");
    // same created_at → lowest id wins
    expect(selectTip([ev("b", 20), ev("a", 20)], now)!.id).toBe("a");
  });

  it("clamps future timestamps so a runaway clock cannot win forever", () => {
    const now = 1_000_000;
    const max = Math.floor(now / 1000) + MAX_CLOCK_SKEW_SEC;
    // both clamp to the same instant → tie broken by id
    expect(selectTip([ev("z", now / 1000 + 99999), ev("a", now / 1000 + 99999)], now)!.id).toBe("a");
    // a sane event beats no one, but a future one doesn't leapfrog an equally-clamped one
    expect(selectTip([ev("m", max + 100)], now)!.id).toBe("m");
  });

  it("returns null for an empty set", () => {
    expect(selectTip([])).toBeNull();
  });
});
