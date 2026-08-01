import { buildRelayQueryPlan, relaysForAuthors } from "./outbox";

const USER = ["wss://user1", "wss://user2"];

describe("buildRelayQueryPlan", () => {
  it("routes each author to the relays they write to", () => {
    const writes: Record<string, string[]> = {
      alice: ["wss://r1"],
      bob: ["wss://r2"],
      carol: ["wss://r1", "wss://r2"],
    };
    const plan = buildRelayQueryPlan(["alice", "bob", "carol"], USER, (pk) => writes[pk] ?? []);
    expect(Array.from(plan.get("wss://r1")!)).toEqual(expect.arrayContaining(["alice", "carol"]));
    expect(Array.from(plan.get("wss://r2")!)).toEqual(expect.arrayContaining(["bob", "carol"]));
    // bob does not write to r1
    expect(plan.get("wss://r1")!.has("bob")).toBe(false);
  });

  it("falls back to user relays for authors with no known outbox (no author dropped)", () => {
    const plan = buildRelayQueryPlan(["ghost"], USER, () => []);
    for (const r of USER) expect(plan.get(r)!.has("ghost")).toBe(true);

    // Coverage guarantee: union of all buckets covers every input author.
    const covered = new Set<string>();
    for (const set of Array.from(plan.values())) for (const a of Array.from(set)) covered.add(a);
    expect(covered.has("ghost")).toBe(true);
  });

  it("respects maxRelays and still covers every author", () => {
    const writes: Record<string, string[]> = {};
    const authors: string[] = [];
    // 30 authors each on a distinct relay → far more relays than the cap.
    for (let i = 0; i < 30; i++) {
      const a = `a${i}`;
      authors.push(a);
      writes[a] = [`wss://relay${i}`];
    }
    const plan = buildRelayQueryPlan(authors, USER, (pk) => writes[pk] ?? [], { maxRelays: 5 });
    expect(plan.size).toBeLessThanOrEqual(5);

    const covered = new Set<string>();
    for (const set of Array.from(plan.values())) for (const a of Array.from(set)) covered.add(a);
    expect(covered.size).toBe(30); // dropped-relay authors fell back to user relays
  });

  it("caps how many relays a single author is fanned to", () => {
    const writes = { alice: ["wss://r1", "wss://r2", "wss://r3", "wss://r4"] };
    const plan = buildRelayQueryPlan(["alice"], [], (pk) => (writes as any)[pk] ?? [], {
      maxRelaysPerAuthor: 2,
      maxRelays: 99,
    });
    let count = 0;
    for (const set of Array.from(plan.values())) if (set.has("alice")) count++;
    expect(count).toBe(2);
  });

  it("fans a single author out to at most 10 relays by default", () => {
    const writes = Array.from({ length: 12 }, (_, i) => `wss://r${i + 1}`);
    const plan = buildRelayQueryPlan(["alice"], [], () => writes);

    expect(Array.from(plan.keys())).toEqual(writes.slice(0, 10));
    for (const authors of plan.values()) expect(authors.has("alice")).toBe(true);
  });

  it("adds uncapped additional relays without broadening an existing relay bucket", () => {
    const additionalRelays = Array.from({ length: 21 }, (_, i) => `wss://additional-${i}`);
    additionalRelays.push("wss://alice");

    const plan = buildRelayQueryPlan(
      ["alice", "bob"],
      [],
      (author) => [`wss://${author}`],
      { maxRelays: 2, additionalRelays },
    );

    expect(plan.get("wss://alice")).toEqual(new Set(["alice"]));
    for (const relay of additionalRelays.slice(0, 21)) {
      expect(plan.get(relay)).toEqual(new Set(["alice", "bob"]));
    }
  });
});

describe("relaysForAuthors", () => {
  it("returns user relays plus the most-popular outbox relays", () => {
    const writes: Record<string, string[]> = {
      a: ["wss://pop", "wss://rare"],
      b: ["wss://pop"],
      c: ["wss://pop"],
    };
    const relays = relaysForAuthors(["a", "b", "c"], USER, (pk) => writes[pk] ?? [], 1);
    expect(relays).toEqual([...USER, "wss://pop"]); // top-1 extra is the popular one
  });
});
