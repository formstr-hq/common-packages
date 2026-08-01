import { RelayCore } from "./RelayCore";
import { EventDB } from "./EventDB";
import { RelayMessage } from "./protocol";
import { makeEvent } from "../testkit";

const NOW = 1_000_000;

function setup() {
  const db = new EventDB(() => NOW);
  const out: RelayMessage[] = [];
  const core = new RelayCore(db, (m) => out.push(m));
  return { db, core, out };
}

const eventsFor = (out: RelayMessage[], subId: string) =>
  out.filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => (m as any)[2].id);

describe("RelayCore REQ", () => {
  it("replays stored matches newest-first, then EOSE", () => {
    const { db, core, out } = setup();
    db.add(makeEvent({ id: "a".repeat(64), created_at: 100 }));
    db.add(makeEvent({ id: "b".repeat(64), created_at: 300 }));
    db.add(makeEvent({ id: "c".repeat(64), created_at: 200 }));

    core.handle(["REQ", "sub1", { kinds: [1] }]);

    expect(eventsFor(out, "sub1")).toEqual(["b".repeat(64), "c".repeat(64), "a".repeat(64)]);
    const eoseIdx = out.findIndex((m) => m[0] === "EOSE");
    const lastEventIdx = out.map((m) => m[0]).lastIndexOf("EVENT");
    expect(eoseIdx).toBeGreaterThan(lastEventIdx); // EOSE after all stored events
  });

  it("streams live events after EOSE to matching subs only", () => {
    const { core, out } = setup();
    core.handle(["REQ", "notes", { kinds: [1] }]);
    core.handle(["REQ", "polls", { kinds: [1068] }]);

    core.handle(["EVENT", makeEvent({ id: "n".repeat(64), kind: 1 })]);
    core.handle(["EVENT", makeEvent({ id: "p".repeat(64), kind: 1068 })]);

    expect(eventsFor(out, "notes")).toEqual(["n".repeat(64)]);
    expect(eventsFor(out, "polls")).toEqual(["p".repeat(64)]);
  });

  it("stops delivery after CLOSE", () => {
    const { core, out } = setup();
    core.handle(["REQ", "sub1", { kinds: [1] }]);
    core.handle(["CLOSE", "sub1"]);
    core.handle(["EVENT", makeEvent({ id: "x".repeat(64), kind: 1 })]);
    expect(eventsFor(out, "sub1")).toEqual([]);
    expect(core.activeSubscriptionCount()).toBe(0);
  });

  it("does not re-deliver an already-replayed event", () => {
    const { db, core, out } = setup();
    const e = makeEvent({ id: "a".repeat(64), kind: 1 });
    db.add(e);
    core.handle(["REQ", "sub1", { kinds: [1] }]);
    // Re-publish the same event — duplicate add, must not double-deliver.
    core.handle(["EVENT", e]);
    expect(eventsFor(out, "sub1")).toEqual(["a".repeat(64)]);
  });

  // Regression: a sub that registered before persistence finished loading (so it
  // replayed an empty store) must still receive the hydrated events. Without the
  // bulkLoad→reset→refresh path it never would: the hydrated copy fans out to no
  // one (bulkLoad suppresses per-event emits) and the later network copy is
  // dropped as a duplicate. This hung the responses view on "Loading form…".
  it("delivers bulk-hydrated events to a sub that registered before hydration", () => {
    const { db, core, out } = setup();

    // Sub registers first — store is still empty, replay delivers nothing.
    core.handle(["REQ", "sub1", { kinds: [30168], authors: ["alice"] }]);
    expect(eventsFor(out, "sub1")).toEqual([]);

    // Persistence hydrates the matching event afterwards (no per-event emit).
    const hydrated = makeEvent({ id: "d".repeat(64), kind: 30168, pubkey: "alice", created_at: 200 });
    db.bulkLoad([
      hydrated,
      makeEvent({ id: "e".repeat(64), kind: 1, pubkey: "bob" }), // non-matching
    ]);

    // The reset refresh hands the matching hydrated event to the waiting sub.
    expect(eventsFor(out, "sub1")).toEqual(["d".repeat(64)]);

    // And a later duplicate (the network copy) does NOT re-deliver.
    core.handle(["INGEST", [hydrated]]);
    expect(eventsFor(out, "sub1")).toEqual(["d".repeat(64)]);
  });

  it("bulkLoad with no new events emits no reset churn", () => {
    const { db, core, out } = setup();
    const e = makeEvent({ id: "a".repeat(64), kind: 1 });
    db.add(e);
    core.handle(["REQ", "sub1", { kinds: [1] }]);
    out.length = 0;
    db.bulkLoad([e]); // already present → added 0 → no reset, no re-delivery
    expect(eventsFor(out, "sub1")).toEqual([]);
  });
});

describe("RelayCore EVENT / INGEST", () => {
  it("acks published events with OK and stores them", () => {
    const { db, core, out } = setup();
    const e = makeEvent({ id: "a".repeat(64) });
    core.handle(["EVENT", e]);
    expect(out.find((m) => m[0] === "OK")).toEqual(["OK", e.id, true, ""]);
    expect(db.getById(e.id)).toBeDefined();
  });

  it("rejects malformed events with OK=false", () => {
    const { core, out } = setup();
    core.handle(["EVENT", { id: "bad" } as any]);
    const ok = out.find((m) => m[0] === "OK") as any;
    expect(ok[2]).toBe(false);
  });

  it("OKs a malformed event with an empty id when none is present", () => {
    const { core, out } = setup();
    core.handle(["EVENT", null as any]);
    expect(out.find((m) => m[0] === "OK")).toEqual(["OK", "", false, "invalid: malformed event"]);
  });

  it("skips malformed events inside an INGEST batch but still fans out ephemerals", () => {
    const { db, core, out } = setup();
    core.handle(["REQ", "eph", { kinds: [20001] }]);
    core.handle(["INGEST", [{ bad: true } as any, makeEvent({ id: "e".repeat(64), kind: 20001 })]]);
    expect(eventsFor(out, "eph")).toEqual(["e".repeat(64)]); // ephemeral fanned out
    expect(db.allEvents()).toHaveLength(0); // malformed skipped, ephemeral not stored
  });

  it("does not re-deliver the same ephemeral event to a sub", () => {
    const { core, out } = setup();
    core.handle(["REQ", "sub1", { kinds: [20001] }]);
    const e = makeEvent({ id: "e".repeat(64), kind: 20001 });
    core.handle(["EVENT", e]);
    core.handle(["EVENT", e]); // already seen by sub1 → not re-sent
    expect(eventsFor(out, "sub1")).toEqual(["e".repeat(64)]);
  });

  it("does not fan store removals (only adds) out to live subs", () => {
    const { db, core, out } = setup();
    const pubkey = "p".repeat(64);
    const note = makeEvent({ id: "n".repeat(64), pubkey, kind: 1 });
    db.add(note);
    core.handle(["REQ", "sub1", { kinds: [1] }]); // replays the note
    // A deletion removes the note → a "remove" store change, which must NOT emit.
    db.add(makeEvent({ id: "d".repeat(64), pubkey, kind: 5, tags: [["e", note.id]] }));
    expect(eventsFor(out, "sub1")).toEqual(["n".repeat(64)]); // only the replay
  });

  it("ingests a batch silently (no OK) and fans out", () => {
    const { db, core, out } = setup();
    core.handle(["REQ", "sub1", { kinds: [1] }]);
    core.handle(["INGEST", [makeEvent({ id: "a".repeat(64) }), makeEvent({ id: "b".repeat(64) })]]);
    expect(out.some((m) => m[0] === "OK")).toBe(false);
    expect(eventsFor(out, "sub1").sort()).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(db.allEvents()).toHaveLength(2);
  });

  it("delivers ephemeral events to live subs without storing", () => {
    const { db, core, out } = setup();
    core.handle(["REQ", "sub1", { kinds: [20001] }]);
    core.handle(["EVENT", makeEvent({ id: "e".repeat(64), kind: 20001 })]);
    expect(eventsFor(out, "sub1")).toEqual(["e".repeat(64)]);
    expect(db.query({ kinds: [20001] })).toHaveLength(0);
  });
});

describe("RelayCore dispose", () => {
  it("detaches the store listener and drops all subscriptions", () => {
    const { db, core, out } = setup();
    core.handle(["REQ", "sub1", { kinds: [1] }]);
    core.dispose();

    expect(core.activeSubscriptionCount()).toBe(0);
    // A post-dispose store change must not fan out to the (gone) sub.
    db.add(makeEvent({ id: "a".repeat(64), kind: 1 }));
    expect(eventsFor(out, "sub1")).toEqual([]);
  });
});
