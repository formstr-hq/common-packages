import { RelayPool, RelayPublishOutcome } from "./RelayPool";
import { RelayConnection, RelayConnectionHandlers } from "./RelayConnection";
import { fakeSocketFactory } from "../testkit";
import { makeEvent } from "../testkit";

const A = "wss://a";
const B = "wss://b";

// subId the pool assigned, read off the REQ frame the socket received.
const subIdOn = (sock: { sent: any[] }) =>
  sock.sent.find((m) => m[0] === "REQ")![1] as string;

function pool() {
  const f = fakeSocketFactory();
  const p = new RelayPool(f.factory, { autoReconnect: false });
  return { f, p };
}

describe("RelayPool EOSE contract", () => {
  it("fires EOSE only after EVERY relay has sent it (not the first)", () => {
    const { f, p } = pool();
    let eosed = 0;
    p.subscribe([A, B], [{ kinds: [1] }], { onEvent: () => {}, onEose: () => eosed++ }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    f.last(B).open();
    const sub = subIdOn(f.last(A));

    f.last(A).emit(["EOSE", sub]);
    expect(eosed).toBe(0); // one relay done — NOT enough

    f.last(B).emit(["EOSE", sub]);
    expect(eosed).toBe(1); // all done — fires once
  });

  it("forces EOSE after the deadline when a relay never replies", () => {
    vi.useFakeTimers();
    try {
      const { f, p } = pool();
      let eosed = 0;
      p.subscribe([A, B], [{ kinds: [1] }], { onEvent: () => {}, onEose: () => eosed++ }, { eoseDeadlineMs: 5000 });
      f.last(A).open();
      f.last(B).open();
      const sub = subIdOn(f.last(A));
      f.last(A).emit(["EOSE", sub]); // B never responds

      expect(eosed).toBe(0);
      vi.advanceTimersByTime(5000);
      expect(eosed).toBe(1);

      // A late EOSE from B must not double-fire.
      f.last(B).emit(["EOSE", sub]);
      expect(eosed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts CLOSED as done and isolates a failing relay", () => {
    const { f, p } = pool();
    let eosed = 0;
    const got: string[] = [];
    p.subscribe([A, B], [{ kinds: [1] }], { onEvent: (e) => got.push(e.id), onEose: () => eosed++ }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    f.last(B).open();
    const sub = subIdOn(f.last(A));

    f.last(A).emit(["EVENT", sub, makeEvent({ id: "a".repeat(64) })]);
    f.last(A).emit(["EOSE", sub]);
    f.last(B).emit(["CLOSED", sub, "auth-required"]); // B fails

    expect(got).toEqual(["a".repeat(64)]); // A's events still delivered
    expect(eosed).toBe(1); // CLOSED let aggregation complete
  });
});

describe("RelayPool delivery", () => {
  it("de-duplicates the same event across relays", () => {
    const { f, p } = pool();
    const got: string[] = [];
    p.subscribe([A, B], [{ kinds: [1] }], { onEvent: (e) => got.push(e.id) }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    f.last(B).open();
    const sub = subIdOn(f.last(A));

    const dup = makeEvent({ id: "d".repeat(64) });
    f.last(A).emit(["EVENT", sub, dup]);
    f.last(B).emit(["EVENT", sub, dup]); // same id from another relay

    expect(got).toEqual(["d".repeat(64)]);
  });

  it("keeps delivering live events after EOSE", () => {
    const { f, p } = pool();
    const got: string[] = [];
    p.subscribe([A], [{ kinds: [1] }], { onEvent: (e) => got.push(e.id) }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    const sub = subIdOn(f.last(A));
    f.last(A).emit(["EOSE", sub]);
    f.last(A).emit(["EVENT", sub, makeEvent({ id: "late".padEnd(64, "0") })]);
    expect(got).toEqual(["late".padEnd(64, "0")]);
  });

  it("query() resolves on EOSE and closes the sub", async () => {
    const { f, p } = pool();
    const promise = p.query([A], { kinds: [1] }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    const sub = subIdOn(f.last(A));
    f.last(A).emit(["EVENT", sub, makeEvent({ id: "q".repeat(64) })]);
    f.last(A).emit(["EOSE", sub]);

    const events = await promise;
    expect(events.map((e) => e.id)).toEqual(["q".repeat(64)]);
    expect(f.last(A).sent.some((m) => m[0] === "CLOSE")).toBe(true);
  });
});

describe("RelayPool publish", () => {
  it("is fire-and-forget without onResult", () => {
    const { f, p } = pool();
    p.publish([A], makeEvent({ id: "a".repeat(64) }));
    f.last(A).open();
    expect(f.last(A).sent.some((m) => m[0] === "EVENT")).toBe(true);
  });

  it("reports an empty result immediately when there are no relays", () => {
    const { p } = pool();
    let res: RelayPublishOutcome[] | undefined;
    p.publish([], makeEvent({ id: "a".repeat(64) }), { onResult: (r) => (res = r) });
    expect(res).toEqual([]);
  });

  it("marks unanswered relays timeout (connected) vs failed (unreachable)", () => {
    vi.useFakeTimers();
    try {
      const { f, p } = pool();
      let res: RelayPublishOutcome[] = [];
      p.publish([A, B], makeEvent({ id: "a".repeat(64) }), { onResult: (r) => (res = r), timeoutMs: 1000 });
      f.last(A).open(); // A connects but never answers; B never opens
      vi.advanceTimersByTime(1000); // deadline elapses

      expect(res.find((r) => r.relay === A)?.status).toBe("timeout");
      expect(res.find((r) => r.relay === B)).toMatchObject({ status: "failed", message: "Relay unreachable" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RelayPool teardown", () => {
  it("resetRelays destroys known connections and skips unknown ones", () => {
    const { f, p } = pool();
    p.subscribe([A], [{ kinds: [1] }], { onEvent: () => {} }, { eoseDeadlineMs: 10 ** 9 });
    f.last(A).open();
    expect(p.relayHealth([A])[0].connected).toBe(true);

    p.resetRelays([A, "wss://never-connected"]); // unknown url is a no-op
    expect(p.relayHealth([A])[0].connected).toBe(false);
  });

  it("ignores stray frames for unknown subscriptions and publishes", () => {
    const { f, p } = pool();
    p.subscribe([A], [{ kinds: [1] }], { onEvent: () => {} }, { eoseDeadlineMs: 10 ** 9 });
    const sock = f.last(A);
    sock.open();
    // EVENT / EOSE for a sub that doesn't exist, OK for an event never published.
    expect(() => {
      sock.emit(["EVENT", "ghost", makeEvent({ id: "a".repeat(64) })]);
      sock.emit(["EOSE", "ghost"]);
      sock.emit(["OK", "z".repeat(64), true, ""]);
      p.unsubscribe("ghost"); // unsubscribing an unknown sub is a no-op
    }).not.toThrow();
  });

  it("a publish deadline firing after completion is a no-op", () => {
    vi.useFakeTimers();
    try {
      const { f, p } = pool();
      let results = 0;
      p.publish([A], makeEvent({ id: "a".repeat(64) }), { onResult: () => results++, timeoutMs: 1000 });
      f.last(A).open();
      f.last(A).emit(["OK", "a".repeat(64), true, ""]); // all relays answered → finishes
      expect(results).toBe(1);
      vi.advanceTimersByTime(1000); // deadline fires, but the publish is already done
      expect(results).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a relay whose connection was reset mid-publish as failed", () => {
    vi.useFakeTimers();
    try {
      const { f, p } = pool();
      let res: RelayPublishOutcome[] = [];
      p.publish([A], makeEvent({ id: "a".repeat(64) }), { onResult: (r) => (res = r), timeoutMs: 1000 });
      f.last(A).open();
      // resetRelays drops the connection but leaves the publish pending, so at the
      // deadline there's no connection to read state from → the `?? false` path.
      p.resetRelays([A]);
      vi.advanceTimersByTime(1000);
      expect(res).toEqual([
        { relay: A, status: "failed", message: "Relay unreachable", latencyMs: expect.any(Number) },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a leftover deadline from a superseded re-publish", () => {
    vi.useFakeTimers();
    try {
      const { f, p } = pool();
      const ev = makeEvent({ id: "a".repeat(64) });
      p.publish([A], ev, { onResult: () => {}, timeoutMs: 1000 }); // first attempt, timer T1
      p.publish([A], ev, { onResult: () => {}, timeoutMs: 5000 }); // supersedes; T1 left scheduled
      f.last(A).open();
      f.last(A).emit(["OK", "a".repeat(64), true, ""]); // second attempt completes, clears its own timer

      // T1 still fires → finishPublish runs with the entry already gone.
      expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeAll clears sub deadlines, pending publishes, and connections", () => {
    const { f, p } = pool();
    p.subscribe([A], [{ kinds: [1] }], { onEvent: () => {} }, { eoseDeadlineMs: 10 ** 9 });
    p.publish([A], makeEvent({ id: "a".repeat(64) }), { onResult: () => {}, timeoutMs: 10 ** 9 });
    f.last(A).open();

    p.closeAll();
    expect(p.relayHealth([A])).toEqual([
      { relay: A, connected: false, connecting: false, reconnecting: false, gossip: false },
    ]);
  });
});

describe("RelayConnection reconnect", () => {
  it("resubscribes active REQs on a fresh socket after a drop", () => {
    vi.useFakeTimers();
    try {
      const f = fakeSocketFactory();
      const handlers: RelayConnectionHandlers = { onEvent: () => {}, onEose: () => {}, onClosed: () => {} };
      const conn = new RelayConnection(A, f.factory, handlers, { autoReconnect: true, baseBackoffMs: 1000 });
      conn.req("sub", [{ kinds: [1] }]);
      f.last(A).open(); // flush initial REQ
      expect(f.last(A).sent.some((m) => m[0] === "REQ")).toBe(true);

      f.last(A).close(); // drop → schedules reconnect
      vi.advanceTimersByTime(1000); // backoff is random*1000 ≤ 1000ms
      expect(f.count(A)).toBe(2); // new socket created

      f.last(A).open(); // reconnect opens → resubscribe
      expect(f.last(A).sent.some((m) => m[0] === "REQ" && m[1] === "sub")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
