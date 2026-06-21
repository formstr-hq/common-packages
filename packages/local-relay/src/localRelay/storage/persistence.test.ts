import { Persistence } from "./persistence";
import { MemoryStorage } from "./MemoryStorage";
import { StorageAdapter } from "./StorageAdapter";
import { EventDB } from "../core/EventDB";
import { defaultPrunePolicy } from "../core/types";
import { makeEvent } from "../testkit";

const NOW = 1_000_000;

// No prune timer / no auto-flush timer interference: we drive flush() manually.
const noTimers = { pruneIntervalMs: 0, debounceMs: 10_000 };

describe("Persistence hydration", () => {
  it("loads persisted events into the DB on start (without echoing back)", async () => {
    const storage = new MemoryStorage();
    await storage.batchPut([makeEvent({ id: "a".repeat(64) }), makeEvent({ id: "b".repeat(64) })]);

    const db = new EventDB(() => NOW);
    const p = new Persistence(db, storage, noTimers);
    await p.start();

    expect(db.allEvents()).toHaveLength(2);
    // Hydration must not re-queue writes back to storage.
    await p.flush();
    expect(storage.size).toBe(2);
  });
});

describe("Persistence write-through", () => {
  it("persists added events on flush", async () => {
    const storage = new MemoryStorage();
    const db = new EventDB(() => NOW);
    const p = new Persistence(db, storage, noTimers);
    await p.start();

    db.add(makeEvent({ id: "a".repeat(64) }));
    db.add(makeEvent({ id: "b".repeat(64) }));
    expect(storage.size).toBe(0); // debounced, not yet written
    await p.flush();
    expect(storage.size).toBe(2);
  });

  it("propagates deletions (NIP-09) to storage", async () => {
    const storage = new MemoryStorage();
    const db = new EventDB(() => NOW);
    const p = new Persistence(db, storage, noTimers);
    await p.start();

    const note = makeEvent({ id: "n".repeat(64), pubkey: "p".repeat(64) });
    db.add(note);
    await p.flush();
    expect(storage.size).toBe(1);

    db.add(makeEvent({ id: "d".repeat(64), pubkey: "p".repeat(64), kind: 5, tags: [["e", note.id]] }));
    await p.flush();
    expect((await storage.loadAll()).find((e) => e.id === note.id)).toBeUndefined();
  });

  it("coalesces add-then-delete within one debounce window", async () => {
    const storage = new MemoryStorage();
    const db = new EventDB(() => NOW);
    const p = new Persistence(db, storage, noTimers);
    await p.start();

    const note = makeEvent({ id: "n".repeat(64), pubkey: "p".repeat(64) });
    db.add(note);
    db.add(makeEvent({ id: "d".repeat(64), pubkey: "p".repeat(64), kind: 5, tags: [["e", note.id]] }));
    await p.flush();
    expect(storage.size).toBe(0); // never persisted, then deleted — net zero
  });
});

describe("Persistence pruning", () => {
  it("prune removes from DB and storage", async () => {
    const storage = new MemoryStorage();
    const db = new EventDB(() => NOW);
    const policy = { ...defaultPrunePolicy(), defaultTtlSeconds: 60 };
    const p = new Persistence(db, storage, { ...noTimers, prunePolicy: policy });
    await p.start();

    db.add(makeEvent({ id: "old".padEnd(64, "0"), created_at: NOW - 1000 }));
    db.add(makeEvent({ id: "new".padEnd(64, "0"), created_at: NOW - 1 }));
    await p.flush();
    expect(storage.size).toBe(2);

    const pruned = p.pruneNow();
    await p.flush();
    expect(pruned).toBe(1);
    const remaining = await storage.loadAll();
    expect(remaining.map((e) => e.id)).toEqual(["new".padEnd(64, "0")]);
  });
});

describe("Persistence stop", () => {
  it("clears timers, detaches write-through, and flushes a final time", async () => {
    const storage = new MemoryStorage();
    const db = new EventDB(() => NOW);
    // Long timers so nothing fires on its own — stop() must do the work.
    const p = new Persistence(db, storage, { debounceMs: 10_000, pruneIntervalMs: 10_000 });
    await p.start();

    db.add(makeEvent({ id: "a".repeat(64) })); // schedules a (long) debounce
    await p.stop(); // clears timers + flushes the pending put
    expect(storage.size).toBe(1);

    // After stop the listener is detached: further changes aren't captured.
    db.add(makeEvent({ id: "b".repeat(64) }));
    await p.flush();
    expect(storage.size).toBe(1);
  });
});

describe("Persistence reentrancy", () => {
  it("does not start a second flush while one is in flight", async () => {
    const written: string[] = [];
    let releasePut: () => void = () => {};
    // A storage whose batchPut hangs until we release it, so we can overlap flushes.
    const storage: StorageAdapter = {
      loadAll: async () => [],
      batchPut: (events) => {
        written.push(...events.map((e) => e.id));
        return new Promise<void>((resolve) => (releasePut = resolve));
      },
      batchDelete: async () => {},
      clear: async () => {},
    };
    const db = new EventDB(() => NOW);
    const p = new Persistence(db, storage, noTimers);
    await p.start();

    db.add(makeEvent({ id: "a".repeat(64) }));
    const first = p.flush(); // sets flushing=true, awaits the hung batchPut
    const second = p.flush(); // flushing in progress → returns immediately
    await second;
    db.add(makeEvent({ id: "b".repeat(64) })); // queued, but the second flush did nothing
    releasePut();
    await first;
    expect(written).toEqual(["a".repeat(64)]); // only the first flush ran
  });
});

describe("MemoryStorage", () => {
  it("clear empties the store", async () => {
    const storage = new MemoryStorage();
    await storage.batchPut([makeEvent({ id: "a".repeat(64) })]);
    expect(storage.size).toBe(1);
    await storage.clear();
    expect(storage.size).toBe(0);
    expect(await storage.loadAll()).toHaveLength(0);
  });
});

describe("Persistence debounce timer", () => {
  it("auto-flushes after the debounce interval", async () => {
    vi.useFakeTimers();
    try {
      const storage = new MemoryStorage();
      const db = new EventDB(() => NOW);
      const p = new Persistence(db, storage, { debounceMs: 1000, pruneIntervalMs: 0 });
      await p.start();

      db.add(makeEvent({ id: "a".repeat(64) }));
      expect(storage.size).toBe(0);
      vi.advanceTimersByTime(1000);
      await Promise.resolve(); // let the async flush settle
      await Promise.resolve();
      expect(storage.size).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
