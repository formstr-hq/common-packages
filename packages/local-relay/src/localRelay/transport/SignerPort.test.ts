import { SignerPort } from "./SignerPort";
import type { Channel } from "./channel";
import { makeEvent } from "../testkit";

function fakeChannel() {
  const posted: any[] = [];
  const channel: Channel = { post: (m) => posted.push(m), onMessage: () => {}, close: () => {} };
  return { channel, posted };
}

describe("SignerPort", () => {
  it("posts a signRequest and resolves with the returned event", async () => {
    const { channel, posted } = fakeChannel();
    const port = new SignerPort(channel);
    const pending = port.sign({ kind: 22242, created_at: 0, tags: [], content: "" });
    expect(posted[0].kind).toBe("signRequest");

    const signed = makeEvent({ id: "a".repeat(64), kind: 22242 });
    port.resolve(posted[0].reqId, signed);
    expect(await pending).toEqual(signed);
  });

  it("resolves null on timeout, and ignores a late resolve afterwards", async () => {
    vi.useFakeTimers();
    try {
      const { channel, posted } = fakeChannel();
      const port = new SignerPort(channel, 1000);
      const pending = port.sign({ kind: 22242, created_at: 0, tags: [], content: "" });

      vi.advanceTimersByTime(1000); // timeout → resolves null
      // A late signResult must be ignored (already settled).
      port.resolve(posted[0].reqId, makeEvent({ id: "b".repeat(64) }));
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a late timeout after it already resolved", async () => {
    vi.useFakeTimers();
    try {
      const { channel, posted } = fakeChannel();
      const port = new SignerPort(channel, 1000);
      const pending = port.sign({ kind: 22242, created_at: 0, tags: [], content: "" });

      const signed = makeEvent({ id: "a".repeat(64), kind: 22242 });
      port.resolve(posted[0].reqId, signed); // settles first
      vi.advanceTimersByTime(1000); // timeout fires but is a no-op
      expect(await pending).toEqual(signed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resolve for an unknown reqId is a no-op", () => {
    const { channel } = fakeChannel();
    const port = new SignerPort(channel);
    expect(() => port.resolve("nope", null)).not.toThrow();
  });
});
