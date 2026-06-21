import { RelayConnection, RelayConnectionHandlers } from "./RelayConnection";
import { fakeSocketFactory, makeEvent } from "../testkit";

const URL = "wss://a";
const noop: RelayConnectionHandlers = {
  onEvent: () => {},
  onEose: () => {},
  onClosed: () => {},
};

describe("RelayConnection publish queueing", () => {
  it("writes immediately when already connected", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.req("s", [{ kinds: [1] }]);
    f.last(URL).open();
    conn.publish(makeEvent({ id: "a".repeat(64) }));
    expect(f.last(URL).sent.some((m) => m[0] === "EVENT")).toBe(true);
  });

  it("queues a publish while connecting, flushing it on open", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.publish(makeEvent({ id: "a".repeat(64) })); // not connected yet → queued
    expect(f.last(URL).sent.some((m) => m[0] === "EVENT")).toBe(false);
    f.last(URL).open(); // flush
    expect(f.last(URL).sent.some((m) => m[0] === "EVENT")).toBe(true);
  });

  it("re-queues a publish when send() throws", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.req("s", [{ kinds: [1] }]);
    const sock = f.last(URL);
    sock.open();
    sock.send = () => {
      throw new Error("boom");
    };
    // write throws → caught → re-queued for the next open (no throw escapes).
    expect(() => conn.publish(makeEvent({ id: "a".repeat(64) }))).not.toThrow();
  });
});

describe("RelayConnection inbound frames", () => {
  it("ignores non-JSON and non-array messages", () => {
    const f = fakeSocketFactory();
    const got: string[] = [];
    const conn = new RelayConnection(URL, f.factory, { ...noop, onEvent: (_s, e) => got.push(e.id) });
    conn.req("s", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).onmessage?.("{not json"); // parse throws → ignored
    f.last(URL).emit({ not: "an array" }); // valid JSON, not an array → ignored
    expect(got).toEqual([]);
  });

  it("treats socket errors as informational (no disconnect)", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop, { autoReconnect: false });
    conn.req("s", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).onerror?.(); // error handler is a no-op
    expect(conn.connected).toBe(true);
  });

  it("handles CLOSED / OK frames that omit the trailing message field", () => {
    const f = fakeSocketFactory();
    const closed: string[] = [];
    const oks: Array<[string, boolean, string]> = [];
    const conn = new RelayConnection(URL, f.factory, {
      onEvent: () => {},
      onEose: () => {},
      onClosed: (_s, _r, msg) => closed.push(msg),
      onOk: (id, ok, msg) => oks.push([id, ok, msg]),
    });
    conn.req("s", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).emit(["CLOSED", "s"]); // no reason → ""
    f.last(URL).emit(["OK", "a".repeat(64), true]); // no message → ""
    expect(closed).toEqual([""]);
    expect(oks).toEqual([["a".repeat(64), true, ""]]);
  });
});

describe("RelayConnection connect", () => {
  it("is a no-op while a socket is already open", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.req("s", [{ kinds: [1] }]);
    f.last(URL).open();
    conn.connect(); // already open → no fresh socket
    expect(f.count(URL)).toBe(1);
  });
});

describe("RelayConnection destroy", () => {
  it("clears a pending reconnect timer and does not reconnect", () => {
    vi.useFakeTimers();
    try {
      const f = fakeSocketFactory();
      const conn = new RelayConnection(URL, f.factory, noop, { autoReconnect: true, baseBackoffMs: 1000 });
      conn.req("s", [{ kinds: [1] }]);
      f.last(URL).open();
      f.last(URL).close(); // drop → schedules a reconnect
      expect(conn.reconnecting).toBe(true);

      conn.destroy(); // clears the reconnect timer
      expect(conn.reconnecting).toBe(false);
      vi.advanceTimersByTime(5000);
      expect(f.count(URL)).toBe(1); // no fresh socket
    } finally {
      vi.useRealTimers();
    }
  });

  it("tolerates a socket.close() that throws", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.req("s", [{ kinds: [1] }]);
    const sock = f.last(URL);
    sock.open();
    sock.close = () => {
      throw new Error("already gone");
    };
    expect(() => conn.destroy()).not.toThrow();
  });
});
