import { RelayConnection, RelayConnectionHandlers } from "./RelayConnection";
import { fakeSocketFactory, makeEvent } from "../testkit";

const URL = "wss://q";
const pk = (n: number) => n.toString(16).padStart(64, "0");

function setup(opts: ConstructorParameters<typeof RelayConnection>[3] = {}) {
  const f = fakeSocketFactory();
  const events: Array<[string, string]> = [];
  const eoses: string[] = [];
  const closed: Array<[string, string]> = [];
  const handlers: RelayConnectionHandlers = {
    onEvent: (sub, e) => events.push([sub, e.id]),
    onEose: (sub) => eoses.push(sub),
    onClosed: (sub, _r, msg) => closed.push([sub, msg]),
  };
  let now = 0;
  const conn = new RelayConnection(URL, f.factory, handlers, {
    reqBurst: 1000,
    reqsPerSecond: 1000,
    now: () => now,
    ...opts,
  });
  const reqs = () => f.last(URL).sent.filter((m) => m[0] === "REQ");
  return { f, conn, events, eoses, closed, reqs, advance: (ms: number) => (now += ms) };
}

describe("RelayConnection queue: subscription cap", () => {
  it("keeps at most maxSubscriptions REQs open and sends the next when one closes", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 3 });
    for (let i = 0; i < 5; i++) conn.req(`s${i}`, [{ kinds: [1], authors: [pk(i)], limit: 10 }]);
    f.last(URL).open();
    expect(reqs().map((m) => m[1])).toEqual(["s0", "s1", "s2"]);
    conn.close("s1");
    expect(f.last(URL).sent).toContainEqual(["CLOSE", "s1"]);
    expect(reqs().map((m) => m[1])).toEqual(["s0", "s1", "s2", "s3"]);
  });

  it("drops a queued sub without ever sending it", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("a", [{ kinds: [1], limit: 5 }]);
    conn.req("b", [{ kinds: [2], limit: 5 }]);
    f.last(URL).open();
    conn.close("b");
    conn.close("a");
    expect(reqs().map((m) => m[1])).toEqual(["a"]);
    expect(f.last(URL).sent).not.toContainEqual(["CLOSE", "b"]);
  });
});

describe("RelayConnection queue: in-flight limit", () => {
  it("keeps at most maxInFlight REQs loading, sending the next as each finishes", () => {
    const { f, conn, reqs } = setup({ maxInFlight: 2, maxSubscriptions: 10 });
    for (let i = 0; i < 4; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
    f.last(URL).open();
    expect(reqs().map((m) => m[1])).toEqual(["s0", "s1"]);
    f.last(URL).emit(["EOSE", "s0"]); // s0 stays open (live) but is no longer loading
    expect(reqs().map((m) => m[1])).toEqual(["s0", "s1", "s2"]);
  });

  it("stops counting a REQ the relay never answers after a timeout", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ maxInFlight: 1 });
      conn.req("silent", [{ kinds: [1], limit: 10 }]);
      conn.req("next", [{ kinds: [2], limit: 10 }]);
      f.last(URL).open();
      expect(reqs().map((m) => m[1])).toEqual(["silent"]);
      advance(8_000);
      vi.advanceTimersByTime(8_000);
      expect(reqs().map((m) => m[1])).toEqual(["silent", "next"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts the subscription limit a relay states", () => {
    const { f, conn } = setup({ maxSubscriptions: 30, maxInFlight: 30 });
    for (let i = 0; i < 12; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
    f.last(URL).open();
    f.last(URL).emit(["NOTICE", "Subscription rejected: Too many subscriptions: Number of subscriptions must be less than or equal to 10"]);
    expect(conn.stats.cap).toBe(9); // one in reserve below the stated 10
  });

  it("halves REQ pacing when a relay says it's getting too many messages", () => {
    const { f, conn } = setup({ reqsPerSecond: 20 });
    conn.req("s", [{ kinds: [1], limit: 1 }]);
    f.last(URL).open();
    f.last(URL).emit(["NOTICE", "rate-limited: too many messages, retry in 1s"]);
    expect(conn.stats.reqRate).toBe(10);
    f.last(URL).emit(["NOTICE", "ERROR: read bandwidth budget exhausted (retry in 30ms)"]);
    expect(conn.stats.reqRate).toBe(10); // bandwidth limits don't change pacing
  });
});

describe("RelayConnection queue: priority", () => {
  it("sends app requests ahead of queued background (low) ones", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("busy", [{ kinds: [1], limit: 5 }]);
    conn.req("bg1", [{ ids: [pk(1)] }], { low: true });
    conn.req("bg2", [{ kinds: [0], authors: [pk(2)], since: 1 }], { low: true });
    conn.req("feed", [{ kinds: [39089], limit: 20 }]);
    f.last(URL).open();
    conn.close("busy");
    expect(reqs().map((m) => m[1])).toEqual(["busy", "feed"]);
    conn.close("feed");
    expect(reqs().map((m) => m[1])).toEqual(["busy", "feed", "bg1"]);
  });

  it("does not merge a background lookup into an app request", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("busy", [{ kinds: [1], limit: 5 }]);
    conn.req("app", [{ ids: [pk(1)] }]);
    conn.req("bg", [{ ids: [pk(2)] }], { low: true });
    f.last(URL).open();
    conn.close("busy");
    expect(reqs()[1]).toEqual(["REQ", "app", { ids: [pk(1)] }]);
  });

  it("sends a user-initiated urgent read ahead of queued standing work", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("busy", [{ kinds: [1], limit: 5 }]);
    conn.req("feed1", [{ kinds: [1], authors: [pk(1)], limit: 20 }]);
    conn.req("feed2", [{ kinds: [1068], limit: 20 }]);
    f.last(URL).open();
    expect(reqs().map((m) => m[1])).toEqual(["busy"]);
    // Opening a note from a notification / revealing poll results.
    conn.req("urgent", [{ ids: [pk(9)] }], { urgent: true });
    conn.close("busy");
    expect(reqs().map((m) => m[1])).toEqual(["busy", "urgent"]);
    conn.close("urgent");
    expect(reqs().map((m) => m[1])).toEqual(["busy", "urgent", "feed1"]);
  });
});

describe("RelayConnection queue: merging", () => {
  it("merges waiting replaceable lookups into one REQ and routes results to each sub", () => {
    const { f, conn, reqs, events, eoses } = setup({ maxSubscriptions: 1 });
    conn.req("feed", [{ kinds: [1], limit: 20 }]); // takes the only slot
    for (let i = 1; i <= 3; i++) conn.req(`r${i}`, [{ kinds: [10002], authors: [pk(i)], limit: 1 }]);
    f.last(URL).open();
    expect(reqs()).toHaveLength(1);

    conn.close("feed");
    const sent = reqs();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(["REQ", "r1", { kinds: [10002], authors: [pk(1), pk(2), pk(3)], limit: 3 }]);

    const e2 = makeEvent({ id: "e2".padEnd(64, "0"), kind: 10002, pubkey: pk(2) });
    f.last(URL).emit(["EVENT", "r1", e2]);
    expect(events).toEqual([["r2", e2.id]]);

    f.last(URL).emit(["EOSE", "r1"]);
    expect(eoses.sort()).toEqual(["r1", "r2", "r3"]);
  });

  it("does not merge 'latest N' queries", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("feed", [{ kinds: [1], limit: 20 }]);
    conn.req("a", [{ kinds: [1], authors: [pk(1)], limit: 5 }]);
    conn.req("b", [{ kinds: [1], authors: [pk(2)], limit: 5 }]);
    f.last(URL).open();
    conn.close("feed");
    conn.close("a");
    expect(reqs().map((m) => m[1])).toEqual(["feed", "a", "b"]);
  });

  it("keeps a merged REQ open until its last member leaves, shrinking it while queued", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 1 });
    conn.req("feed", [{ kinds: [1], limit: 20 }]);
    conn.req("x", [{ kinds: [7], "#e": ["a"] }]);
    conn.req("y", [{ kinds: [7], "#e": ["b"] }]);
    f.last(URL).open();
    conn.close("x"); // still queued → shrinks to y's filter
    conn.close("feed");
    expect(reqs()[1]).toEqual(["REQ", "x", { kinds: [7], "#e": ["b"] }]);
    conn.close("y");
    expect(f.last(URL).sent).toContainEqual(["CLOSE", "x"]);
  });
});

describe("RelayConnection queue: splitting", () => {
  it("splits an oversized author list and reports EOSE only after every part", () => {
    const { f, conn, reqs, eoses } = setup({ maxFilterItems: 300 });
    const authors = Array.from({ length: 700 }, (_, i) => pk(i));
    conn.req("big", [{ kinds: [1984], authors, "#e": ["n"], limit: 500 }]);
    f.last(URL).open();
    const parts = reqs();
    expect(parts.length).toBe(4);
    expect(parts.flatMap((m) => m[2].authors)).toEqual(authors);
    for (const m of parts.slice(0, -1)) {
      f.last(URL).emit(["EOSE", m[1]]);
      expect(eoses).toEqual([]);
    }
    f.last(URL).emit(["EOSE", parts[parts.length - 1][1]]);
    expect(eoses).toEqual(["big"]);
  });

  it("splits and retries a REQ the relay closes as too large", () => {
    const { f, conn, reqs, eoses } = setup();
    conn.req("s", [{ kinds: [0], authors: [pk(1), pk(2), pk(3), pk(4)] }]);
    f.last(URL).open();
    f.last(URL).emit(["CLOSED", "s", "ERROR: bad req: total filter items too large"]);
    const retried = reqs().slice(1);
    expect(retried).toHaveLength(2);
    expect(retried.flatMap((m) => m[2].authors)).toEqual([pk(1), pk(2), pk(3), pk(4)]);
    for (const m of retried) f.last(URL).emit(["EOSE", m[1]]);
    expect(eoses).toEqual(["s"]);
  });
});

describe("RelayConnection queue: relay pushback", () => {
  it("re-queues a rate-limited REQ instead of treating it as done, and waits before resending", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, eoses, closed, advance } = setup();
      conn.req("s", [{ kinds: [1], limit: 10 }]);
      f.last(URL).open();
      f.last(URL).emit(["CLOSED", "s", "rate-limited: too many messages, retry in 2s"]);
      expect(eoses).toEqual([]);
      expect(closed).toEqual([]);
      expect(reqs()).toHaveLength(1);
      advance(2000);
      vi.advanceTimersByTime(2000);
      expect(reqs()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses all REQs on a rate-limit NOTICE", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup();
      conn.req("a", [{ kinds: [1], limit: 10 }]);
      f.last(URL).open();
      f.last(URL).emit(["NOTICE", "rate-limited: too many messages, retry in 1s"]);
      conn.req("b", [{ kinds: [2], limit: 10 }]);
      expect(reqs().map((m) => m[1])).toEqual(["a"]);
      advance(1000);
      vi.advanceTimersByTime(1000);
      expect(reqs().map((m) => m[1])).toEqual(["a", "b"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lowers the loading-REQ limit on a 'too many concurrent REQs' NOTICE", () => {
    const { f, conn } = setup({ maxSubscriptions: 30, maxInFlight: 16 });
    for (let i = 0; i < 10; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
    f.last(URL).open();
    f.last(URL).emit(["NOTICE", "ERROR: too many concurrent REQs"]);
    expect(conn.stats.inFlightCap).toBe(9);
    expect(conn.stats.cap).toBe(30); // total open cap untouched
    expect(f.last(URL).sent).toContainEqual(["CLOSE", "s9"]);
  });

  it("lowers the cap and re-queues the last REQ on a 'too many subscriptions' NOTICE", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ maxSubscriptions: 10 });
      for (let i = 0; i < 4; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
      f.last(URL).open();
      f.last(URL).emit(["NOTICE", "Too many subscriptions"]);
      expect(conn.stats.cap).toBe(3);
      expect(f.last(URL).sent).toContainEqual(["CLOSE", "s3"]);
      advance(5000);
      vi.advanceTimersByTime(5000);
      // s3 waits for a free slot under the lowered cap.
      expect(reqs().filter((m) => m[1] === "s3")).toHaveLength(1);
      conn.close("s0");
      expect(reqs().filter((m) => m[1] === "s3")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats other CLOSED reasons as final and does not resend them on reconnect", () => {
    const { f, conn, reqs, closed } = setup({ autoReconnect: false });
    conn.req("s", [{ kinds: [1], limit: 10 }]);
    f.last(URL).open();
    f.last(URL).emit(["CLOSED", "s", "blocked: not allowed"]);
    expect(closed).toEqual([["s", "blocked: not allowed"]]);
    f.last(URL).close();
    conn.connect();
    f.last(URL).open();
    expect(reqs()).toHaveLength(0);
  });
});

describe("RelayConnection queue: pacing and reconnects", () => {
  it("paces REQs with a token bucket", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ reqBurst: 2, reqsPerSecond: 2, maxSubscriptions: 10 });
      for (let i = 0; i < 4; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
      f.last(URL).open();
      expect(reqs()).toHaveLength(2);
      advance(500);
      vi.advanceTimersByTime(500);
      expect(reqs()).toHaveLength(3);
      advance(500);
      vi.advanceTimersByTime(500);
      expect(reqs()).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resubscribes through the queue after a reconnect, respecting the cap", () => {
    const { f, conn, reqs } = setup({ maxSubscriptions: 2, autoReconnect: false });
    for (let i = 0; i < 3; i++) conn.req(`s${i}`, [{ kinds: [i], limit: 10 }]);
    f.last(URL).open();
    f.last(URL).close();
    conn.connect();
    f.last(URL).open();
    expect(reqs().map((m) => m[1])).toEqual(["s0", "s1"]);
  });

  it("does not reset reconnect backoff for a connection the relay drops right away", () => {
    vi.useFakeTimers();
    const rand = vi.spyOn(Math, "random").mockReturnValue(0.999);
    try {
      const { f, conn } = setup({ baseBackoffMs: 1000, stableConnectionMs: 10_000 });
      conn.req("s", [{ kinds: [1], limit: 1 }]);
      for (let attempt = 0; attempt < 3; attempt++) {
        f.last(URL).open();
        f.last(URL).close(); // kicked immediately
        const before = f.count(URL);
        vi.advanceTimersByTime(1000 * 2 ** attempt - 10);
        expect(f.count(URL)).toBe(before); // still waiting: backoff kept growing
        vi.advanceTimersByTime(20);
        expect(f.count(URL)).toBe(before + 1);
      }
    } finally {
      rand.mockRestore();
      vi.useRealTimers();
    }
  });
});

/** A realistic wall-clock start (ms) so "60s before now" is a valid timestamp. */
const T0 = 1_700_000_000_000;

describe("RelayConnection queue: rotating caught-up subscriptions", () => {
  it("frees a slot for a waiting request by rotating out the oldest caught-up sub", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance, eoses } = setup({ maxSubscriptions: 1 });
      advance(T0);
      conn.req("live", [{ kinds: [1], authors: [pk(1)] }]);
      f.last(URL).open();
      f.last(URL).emit(["EOSE", "live"]);
      advance(6_000);

      conn.req("lookup", [{ ids: [pk(9)] }]);
      expect(f.last(URL).sent).toContainEqual(["CLOSE", "live"]);
      expect(reqs().at(-1)).toEqual(["REQ", "lookup", { ids: [pk(9)] }]);

      // When the lookup finishes, the rotated sub resumes with `since`.
      f.last(URL).emit(["EOSE", "lookup"]);
      conn.close("lookup");
      const resumed = reqs().at(-1)!;
      expect(resumed[1]).toBe("live");
      expect(resumed[2].since).toBe(Math.floor((T0 + 6_000) / 1000) - 60);
      expect(eoses.filter((s) => s === "live")).toHaveLength(1); // no second EOSE to the app
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rotate a sub that hasn't caught up yet, or was opened too recently", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ maxSubscriptions: 1 });
      conn.req("loading", [{ kinds: [1], authors: [pk(1)] }]);
      f.last(URL).open();
      advance(20_000); // open long enough, but no EOSE yet
      conn.req("lookup", [{ ids: [pk(9)] }]);
      expect(reqs().map((m) => m[1])).toEqual(["loading"]);

      f.last(URL).emit(["EOSE", "loading"]); // caught up — but rotation needs 15s open
      expect(reqs().map((m) => m[1])).toEqual(["loading", "lookup"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a finished window dormant instead of re-sending it", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ maxSubscriptions: 1 });
      advance(T0);
      conn.req("page", [{ kinds: [1], authors: [pk(1)], until: 5, limit: 20 }]);
      f.last(URL).open();
      f.last(URL).emit(["EOSE", "page"]);
      advance(6_000);
      conn.req("lookup", [{ ids: [pk(9)] }]);
      f.last(URL).emit(["EOSE", "lookup"]);
      conn.close("lookup");
      // The page's window ended long ago: rotating it out was free, and it is
      // never re-sent (nothing new can match `until: 5`).
      expect(reqs().filter((m) => m[1] === "page")).toHaveLength(1);
      expect(conn.stats.open).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never stalls when the next in line is itself a rotated sub", () => {
    vi.useFakeTimers();
    try {
      const { f, conn, reqs, advance } = setup({ maxSubscriptions: 2 });
      advance(T0);
      conn.req("a", [{ kinds: [1], authors: [pk(1)] }]);
      conn.req("b", [{ kinds: [2], authors: [pk(2)] }]);
      f.last(URL).open();
      f.last(URL).emit(["EOSE", "a"]);
      f.last(URL).emit(["EOSE", "b"]);
      advance(6_000);
      conn.req("x", [{ kinds: [7], "#e": [pk(8)] }]); // a new request rotates a out
      f.last(URL).emit(["EOSE", "x"]);
      // Slots: b, x — both long-lived and caught up. Next in line: rotated a.
      advance(6_000);
      vi.advanceTimersByTime(6_000);
      // A rotated sub only displaces one open 30s+ — no 5-second swapping…
      expect(reqs().filter((m) => m[1] === "a")).toHaveLength(1);
      advance(30_000);
      vi.advanceTimersByTime(30_000);
      // …but it does get back in rather than stalling forever.
      expect(reqs().filter((m) => m[1] === "a")).toHaveLength(2);
      expect(reqs().filter((m) => m[1] === "a").at(-1)![2].since).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes caught-up subs with `since` after a reconnect", () => {
    const { f, conn, reqs, advance } = setup({ autoReconnect: false });
    advance(T0);
    conn.req("live", [{ kinds: [1], authors: [pk(1)] }]);
    conn.req("loading", [{ kinds: [7], "#e": [pk(2)] }]);
    f.last(URL).open();
    f.last(URL).emit(["EOSE", "live"]);
    advance(100_000);
    f.last(URL).close();
    conn.connect();
    f.last(URL).open();
    const sent = Object.fromEntries(reqs().map((m) => [m[1], m[2]]));
    expect(sent.live.since).toBe(Math.floor((T0 + 100_000) / 1000) - 60);
    expect(sent.loading.since).toBeUndefined(); // never caught up → full re-request
  });
});
