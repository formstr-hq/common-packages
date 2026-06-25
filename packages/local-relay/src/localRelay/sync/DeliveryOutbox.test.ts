import { DeliveryOutbox, DeliveryOutboxDeps } from "./DeliveryOutbox";
import type { Event, OutboxRecord } from "../core/types";
import type { RelayPublishOutcome } from "./RelayPool";

const ev = (id: string): Event => ({
  id,
  pubkey: "me",
  created_at: 1,
  kind: 1,
  tags: [],
  content: "",
  sig: "",
});

const outcome = (relay: string, status: RelayPublishOutcome["status"]): RelayPublishOutcome => ({
  relay,
  status,
  latencyMs: 0,
});

interface PublishCall {
  relays: string[];
  event: Event;
  resolve: (results: RelayPublishOutcome[]) => void;
}

function harness(opts: Partial<DeliveryOutboxDeps> & { withStorage?: boolean; withSchedule?: boolean } = {}) {
  let now = 1000;
  const events = new Map<string, Event>();
  const calls: PublishCall[] = [];
  const puts: OutboxRecord[][] = [];
  const deletes: string[][] = [];
  let scheduled = 0;

  const withStorage = opts.withStorage ?? true;
  const withSchedule = opts.withSchedule ?? true;

  const ob = new DeliveryOutbox({
    now: () => now,
    getEvent: (id) => events.get(id),
    publish: (relays, event, resolve) => calls.push({ relays, event, resolve }),
    storage: withStorage
      ? {
          putOutbox: async (r) => {
            puts.push(r);
          },
          deleteOutbox: async (ids) => {
            deletes.push(ids);
          },
        }
      : null,
    onScheduled: withSchedule ? () => scheduled++ : undefined,
    baseBackoffMs: opts.baseBackoffMs,
    maxBackoffMs: opts.maxBackoffMs,
    maxAttempts: opts.maxAttempts ?? 3,
  });

  return {
    ob,
    events,
    calls,
    puts,
    deletes,
    setNow: (n: number) => (now = n),
    now: () => now,
    scheduled: () => scheduled,
    /** Resolve the most recent publish attempt with the given outcomes. */
    resolveLast: (results: RelayPublishOutcome[]) => calls[calls.length - 1].resolve(results),
  };
}

describe("DeliveryOutbox", () => {
  it("marks owed relays and persists; ignores an empty relay set", () => {
    const h = harness();
    h.ob.mark("a", []); // no-op
    expect(h.ob.pendingCount()).toBe(0);

    h.ob.mark("a", ["wss://r1", "wss://r1", "wss://r2"]); // de-duped
    expect(h.ob.snapshot()).toEqual([
      { eventId: "a", pending: ["wss://r1", "wss://r2"], attempts: 0, nextAttemptAt: 1000, failed: false },
    ]);
    expect(h.ob.pendingCount()).toBe(2);
    expect(h.puts.length).toBe(1);
    expect(h.scheduled()).toBe(1);
  });

  it("unions a second mark into the existing record", () => {
    const h = harness();
    h.ob.mark("a", ["wss://r1"]);
    h.setNow(2000);
    h.ob.mark("a", ["wss://r2"]);
    expect(h.ob.snapshot()[0]).toMatchObject({ pending: ["wss://r1", "wss://r2"], nextAttemptAt: 2000 });
  });

  it("flushRelay re-sends only what's owed to that relay; accept clears it", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1", "wss://r2"]);

    h.ob.flushRelay("wss://r3"); // owed to nobody → no attempt
    expect(h.calls.length).toBe(0);

    h.ob.flushRelay("wss://r1");
    expect(h.calls[0].relays).toEqual(["wss://r1"]);
    h.resolveLast([outcome("wss://r1", "accepted")]);
    expect(h.ob.snapshot()[0].pending).toEqual(["wss://r2"]); // r1 delivered
    expect(h.ob.pendingCount()).toBe(1);
  });

  it("removes the record once every relay has accepted (delivered) and deletes from storage", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.flushRelay("wss://r1");
    h.resolveLast([outcome("wss://r1", "accepted")]);
    expect(h.ob.pendingCount()).toBe(0);
    expect(h.deletes).toContainEqual(["a"]);
  });

  it("treats a rejection as terminal — drops that relay without retrying", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.flushRelay("wss://r1");
    h.resolveLast([outcome("wss://r1", "rejected")]);
    expect(h.ob.pendingCount()).toBe(0); // gone, never retried
  });

  it("keeps and backs off a timeout/failed relay; sweep retries only when due", () => {
    const h = harness({ baseBackoffMs: 1000 });
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);

    h.ob.sweep(); // due now (nextAttemptAt=1000, now=1000)
    h.resolveLast([outcome("wss://r1", "timeout")]);
    expect(h.ob.snapshot()[0]).toMatchObject({ attempts: 1, nextAttemptAt: 2000 }); // now+base

    h.ob.sweep(); // not due yet (now still 1000 < 2000)
    expect(h.calls.length).toBe(1); // no new attempt

    h.setNow(2000);
    h.ob.sweep(); // due
    expect(h.calls.length).toBe(2);
    h.resolveLast([outcome("wss://r1", "failed")]);
    expect(h.ob.snapshot()[0]).toMatchObject({ attempts: 2, nextAttemptAt: 2000 + 2000 }); // base*2
  });

  it("caps backoff at maxBackoffMs", () => {
    const h = harness({ baseBackoffMs: 1000, maxBackoffMs: 1500 });
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "timeout")]); // attempts 1 → base 1000
    h.setNow(h.ob.snapshot()[0].nextAttemptAt);
    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "timeout")]); // attempts 2 → base*2=2000 capped to 1500
    expect(h.ob.snapshot()[0].nextAttemptAt - h.now()).toBe(1500);
  });

  it("marks a record FAILED after maxAttempts (kept for manual retry, not dropped)", () => {
    const h = harness({ maxAttempts: 2, baseBackoffMs: 1000 });
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);

    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "timeout")]); // attempts 1
    h.setNow(h.ob.snapshot()[0].nextAttemptAt);
    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "timeout")]); // attempts 2 ≥ max → fail

    expect(h.ob.failedCount()).toBe(1);
    expect(h.ob.snapshot()[0]).toMatchObject({ failed: true, pending: ["wss://r1"] });
    expect(h.ob.pendingCount()).toBe(0); // failed records aren't counted as pending
    expect(h.deletes).not.toContainEqual(["a"]); // KEPT, not dropped
    expect(h.events.get("a")).toBeDefined();

    // A failed record is skipped by all automatic triggers.
    h.setNow(h.now() + 1_000_000);
    h.ob.sweep();
    h.ob.flushRelay("wss://r1");
    expect(h.ob.earliestNextAttemptAt()).toBeNull();
    expect(h.calls.length).toBe(2); // no new attempt beyond the two that failed
  });

  it("retry() re-arms failed records and attempts them again", () => {
    const h = harness({ maxAttempts: 1 });
    h.events.set("a", ev("a"));
    h.events.set("b", ev("b"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.mark("b", ["wss://r2"]);
    h.ob.sweep();
    h.calls[0].resolve([outcome("wss://r1", "timeout")]); // a → failed
    h.calls[1].resolve([outcome("wss://r2", "timeout")]); // b → failed
    expect(h.ob.failedCount()).toBe(2);

    h.ob.retry("a"); // just `a`
    expect(h.ob.snapshot().find((r) => r.eventId === "a")).toMatchObject({ failed: false, attempts: 0 });
    expect(h.ob.failedCount()).toBe(1); // b still failed
    expect(h.calls[h.calls.length - 1].relays).toEqual(["wss://r1"]); // re-attempted

    h.ob.retry(); // all remaining failed
    expect(h.ob.failedCount()).toBe(0);
  });

  it("handles a mixed result: accept one relay, keep the failed one", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1", "wss://r2"]);
    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "accepted"), outcome("wss://r2", "timeout")]);
    expect(h.ob.snapshot()[0]).toMatchObject({ pending: ["wss://r2"], attempts: 1 });
  });

  it("drops a record whose event has vanished (deleted/expired/pruned) on attempt", () => {
    const h = harness();
    h.ob.mark("gone", ["wss://r1"]); // never put the event in `events`
    h.ob.sweep();
    expect(h.calls.length).toBe(0); // nothing to publish
    expect(h.ob.pendingCount()).toBe(0);
    expect(h.deletes).toContainEqual(["gone"]);
  });

  it("remove() drops debt and is a no-op for an unknown id", () => {
    const h = harness();
    h.ob.mark("a", ["wss://r1"]);
    h.ob.remove("missing"); // no-op
    expect(h.ob.pendingCount()).toBe(1);
    h.ob.remove("a");
    expect(h.ob.pendingCount()).toBe(0);
    expect(h.deletes).toContainEqual(["a"]);
  });

  it("does not attempt or schedule a record that's already in flight", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.sweep(); // in flight now (unresolved)
    expect(h.ob.earliestNextAttemptAt()).toBeNull(); // skipped while in flight

    h.ob.sweep(); // second sweep must NOT double-send
    h.ob.flushRelay("wss://r1"); // nor flushRelay
    expect(h.calls.length).toBe(1);

    h.resolveLast([outcome("wss://r1", "timeout")]); // resolves → eligible again
    expect(h.ob.earliestNextAttemptAt()).not.toBeNull();
  });

  it("ignores a result that lands after the record was removed", () => {
    const h = harness();
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.sweep();
    h.ob.remove("a"); // e.g. the user deleted it mid-flight
    expect(() => h.resolveLast([outcome("wss://r1", "timeout")])).not.toThrow();
    expect(h.ob.pendingCount()).toBe(0);
  });

  it("hydrate loads non-empty records and skips empty ones", () => {
    const h = harness();
    h.ob.hydrate([
      { eventId: "a", pending: ["wss://r1"], attempts: 1, nextAttemptAt: 500 },
      { eventId: "b", pending: [], attempts: 0, nextAttemptAt: 0 }, // skip
    ]);
    expect(h.ob.snapshot().map((r) => r.eventId)).toEqual(["a"]);
    expect(h.ob.earliestNextAttemptAt()).toBe(500);
  });

  it("earliestNextAttemptAt returns the soonest due time, or null when empty", () => {
    const h = harness();
    expect(h.ob.earliestNextAttemptAt()).toBeNull();
    h.ob.mark("a", ["wss://r1"]);
    h.setNow(5000);
    h.ob.mark("b", ["wss://r2"]);
    expect(h.ob.earliestNextAttemptAt()).toBe(1000); // a marked at now=1000
  });

  it("works with no storage and no onScheduled (in-memory, best-effort)", () => {
    const h = harness({ withStorage: false, withSchedule: false });
    h.events.set("a", ev("a"));
    h.ob.hydrate([{ eventId: "a", pending: ["wss://r1"], attempts: 0, nextAttemptAt: 0 }]);
    h.ob.mark("a", ["wss://r2"]);
    h.ob.sweep();
    expect(() => h.resolveLast([outcome("wss://r1", "accepted"), outcome("wss://r2", "accepted")])).not.toThrow();
    expect(h.ob.pendingCount()).toBe(0); // delivered; no storage calls, no throw
    expect(h.puts.length).toBe(0);
    expect(h.deletes.length).toBe(0);
  });

  it("uses sane defaults when backoff/attempts options are omitted", () => {
    const h = harness({ baseBackoffMs: undefined, maxBackoffMs: undefined, maxAttempts: undefined });
    h.events.set("a", ev("a"));
    h.ob.mark("a", ["wss://r1"]);
    h.ob.sweep();
    h.resolveLast([outcome("wss://r1", "timeout")]);
    // default base is 2000ms → first retry 2000ms out.
    expect(h.ob.snapshot()[0].nextAttemptAt).toBe(1000 + 2000);
  });
});
