import {
  isReplaceableEvent,
  isEphemeralEvent,
  getReplaceableKey,
  shouldReplaceEvent,
  isValidEventStructure,
  isExpired,
} from "./eventValidation";
import { makeEvent } from "../testkit";

describe("event classification", () => {
  it("isReplaceableEvent covers metadata/contacts + the 10k & 30k ranges", () => {
    expect(isReplaceableEvent(0)).toBe(true);
    expect(isReplaceableEvent(3)).toBe(true);
    expect(isReplaceableEvent(10002)).toBe(true);
    expect(isReplaceableEvent(30023)).toBe(true);
    expect(isReplaceableEvent(1)).toBe(false);
    expect(isReplaceableEvent(20001)).toBe(false);
  });

  it("isEphemeralEvent flags only 20000–29999", () => {
    expect(isEphemeralEvent(20001)).toBe(true);
    expect(isEphemeralEvent(1)).toBe(false);
    expect(isEphemeralEvent(30000)).toBe(false);
  });

  it("getReplaceableKey keys addressable by d-tag, plain by kind:pubkey", () => {
    const p = "p".repeat(64);
    expect(getReplaceableKey(makeEvent({ kind: 30023, pubkey: p, tags: [["d", "x"]] }))).toBe(`30023:${p}:x`);
    expect(getReplaceableKey(makeEvent({ kind: 30023, pubkey: p, tags: [] }))).toBe(`30023:${p}:`);
    expect(getReplaceableKey(makeEvent({ kind: 0, pubkey: p }))).toBe(`0:${p}`);
  });
});

describe("shouldReplaceEvent", () => {
  it("newer created_at wins", () => {
    const newer = makeEvent({ id: "1".repeat(64), created_at: 200 });
    const older = makeEvent({ id: "2".repeat(64), created_at: 100 });
    expect(shouldReplaceEvent(newer, older)).toBe(true);
    expect(shouldReplaceEvent(older, newer)).toBe(false);
  });

  it("breaks created_at ties by the lexicographically larger id", () => {
    const lo = makeEvent({ id: "a".repeat(64), created_at: 100 });
    const hi = makeEvent({ id: "b".repeat(64), created_at: 100 });
    expect(shouldReplaceEvent(hi, lo)).toBe(true);
    expect(shouldReplaceEvent(lo, hi)).toBe(false);
  });
});

describe("isValidEventStructure", () => {
  const ok = makeEvent({ id: "a".repeat(64) });

  it("accepts a well-formed event", () => {
    expect(isValidEventStructure(ok)).toBe(true);
  });

  it("rejects null / non-object", () => {
    expect(isValidEventStructure(null)).toBe(false);
    expect(isValidEventStructure(42)).toBe(false);
  });

  it("rejects each mistyped field", () => {
    expect(isValidEventStructure({ ...ok, id: 1 })).toBe(false);
    expect(isValidEventStructure({ ...ok, pubkey: 1 })).toBe(false);
    expect(isValidEventStructure({ ...ok, created_at: "x" })).toBe(false);
    expect(isValidEventStructure({ ...ok, kind: "x" })).toBe(false);
    expect(isValidEventStructure({ ...ok, tags: "x" })).toBe(false);
    expect(isValidEventStructure({ ...ok, content: 1 })).toBe(false);
    expect(isValidEventStructure({ ...ok, sig: 1 })).toBe(false);
  });
});

describe("isExpired (NIP-40)", () => {
  it("is true once now passes the expiration, false before, false without the tag", () => {
    expect(isExpired(makeEvent({ tags: [["expiration", "100"]] }), 200)).toBe(true);
    expect(isExpired(makeEvent({ tags: [["expiration", "300"]] }), 200)).toBe(false);
    expect(isExpired(makeEvent({ tags: [] }), 200)).toBe(false);
  });
});
