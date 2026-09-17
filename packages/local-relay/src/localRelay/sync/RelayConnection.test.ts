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

describe("RelayConnection NIP-42 AUTH", () => {
  const AUTH_OK = makeEvent({ id: "auth".padEnd(64, "0"), kind: 22242 });

  /** A connection whose handler records the templates it was asked to sign. */
  function withSigner(result: (t: unknown) => Promise<unknown>) {
    const f = fakeSocketFactory();
    const templates: any[] = [];
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: (t) => {
        templates.push(t);
        return result(t) as any;
      },
    });
    return { f, conn, templates };
  }

  it("signs a challenge, replies AUTH, and replays active REQs", async () => {
    const f = fakeSocketFactory();
    const templates: any[] = [];
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: async (t) => {
        templates.push(t);
        return AUTH_OK;
      },
    });
    conn.req("s1", [{ kinds: [1059] }]);
    f.last(URL).open();

    f.last(URL).emit(["AUTH", "challenge-xyz"]);
    await Promise.resolve();
    await Promise.resolve();

    // The template is bound to THIS relay and carries the challenge verbatim.
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      kind: 22242,
      content: "",
      tags: [["relay", URL], ["challenge", "challenge-xyz"]],
    });
    expect(typeof templates[0].created_at).toBe("number");

    const sent = f.last(URL).sent;
    const auth = sent.find((m) => m[0] === "AUTH");
    expect(auth).toEqual(["AUTH", AUTH_OK]);
    // REQs sent before AUTH were not honoured: the sub must be replayed AFTER.
    const authIndex = sent.findIndex((m) => m[0] === "AUTH");
    const reqIndexes = sent
      .map((m, i) => (m[0] === "REQ" && m[1] === "s1" ? i : -1))
      .filter((i) => i >= 0);
    expect(reqIndexes.length).toBe(2); // initial + post-auth replay
    expect(Math.max(...reqIndexes)).toBeGreaterThan(authIndex);
  });

  it("stays silent when no onAuth hook is configured", () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, noop);
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).emit(["AUTH", "c1"]);
    expect(f.last(URL).sent.some((m) => m[0] === "AUTH")).toBe(false);
  });

  it("treats a refused signature as unauthenticated (no AUTH frame)", async () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: async () => null,
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).emit(["AUTH", "c1"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.last(URL).sent.some((m) => m[0] === "AUTH")).toBe(false);
  });

  it("survives a throwing signer", async () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: async () => {
        throw new Error("bunker down");
      },
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    expect(() => f.last(URL).emit(["AUTH", "c1"])).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.last(URL).sent.some((m) => m[0] === "AUTH")).toBe(false);
  });

  it("signs each distinct challenge once, and never concurrently", async () => {
    const f = fakeSocketFactory();
    const templates: any[] = [];
    let release: (() => void) | null = null;
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: (t) => {
        templates.push(t);
        return new Promise((resolve) => {
          release = () => resolve(AUTH_OK);
        });
      },
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    // Two AUTHs while the first sign is still in flight: only one sign starts.
    f.last(URL).emit(["AUTH", "c1"]);
    f.last(URL).emit(["AUTH", "c2"]);
    expect(templates).toHaveLength(1);
    release!();
    await Promise.resolve();
    await Promise.resolve();
    // A repeat of the SAME challenge is not re-signed...
    f.last(URL).emit(["AUTH", "c1"]);
    expect(templates).toHaveLength(1);
    // ...but a genuinely new one is.
    f.last(URL).emit(["AUTH", "c3"]);
    expect(templates).toHaveLength(2);
  });

  it("ignores an AUTH frame with no challenge string", () => {
    const f = fakeSocketFactory();
    const templates: any[] = [];
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: async (t) => {
        templates.push(t);
        return AUTH_OK;
      },
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).emit(["AUTH"]);
    f.last(URL).emit(["AUTH", ""]);
    expect(templates).toHaveLength(0);
  });

  it("does not send AUTH on a socket that dropped while signing", async () => {
    const f = fakeSocketFactory();
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      onAuth: async () => AUTH_OK,
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    const sock = f.last(URL);
    // Emit the challenge, then drop before the awaited sign resolves.
    sock.onmessage?.(
      JSON.stringify(["AUTH", "c-drop"]),
    );
    sock.close();
    await Promise.resolve();
    await Promise.resolve();
    expect(sock.sent.some((m) => m[0] === "AUTH")).toBe(false);
  });

  it("re-authenticates after a reconnect (new socket, same challenge)", async () => {
    const f = fakeSocketFactory();
    const templates: any[] = [];
    const conn = new RelayConnection(URL, f.factory, {
      ...noop,
      autoReconnect: false,
      onAuth: async (t) => {
        templates.push(t);
        return AUTH_OK;
      },
    });
    conn.req("s1", [{ kinds: [1] }]);
    f.last(URL).open();
    f.last(URL).emit(["AUTH", "same"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(templates).toHaveLength(1);

    // Drop and reconnect manually: a fresh socket must sign again even for the
    // identical challenge string, or the new socket stays unauthenticated.
    f.last(URL).close();
    conn.connect();
    f.last(URL).open();
    f.last(URL).emit(["AUTH", "same"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(templates).toHaveLength(2);
  });
});
