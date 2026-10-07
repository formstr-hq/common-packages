import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services", () => ({
  mail: {
    readMail: vi.fn(),
    sendMail: vi.fn(),
    requestMailbox: vi.fn(),
    publishMailSetup: vi.fn(),
    mailIdentity: vi.fn(),
    listAliases: vi.fn(),
    defaultSenderAddress: vi.fn(),
  },
}));

import { mail } from "../src/services";
import { mailTools } from "../src/tools/mail";
import type { ToolCtx } from "../src/tools/types";

type FakeTools = Map<string, { handler: (a: any) => Promise<any> }>;

// Mirror the stdio adapter: skip `write` tools unless allowWrites, inject ctx.
function register(ctx: ToolCtx): FakeTools {
  const tools: FakeTools = new Map();
  for (const t of mailTools) {
    if (t.write && !ctx.allowWrites) continue;
    tools.set(t.name, { handler: (a: any) => t.handler(a, ctx) });
  }
  return tools;
}

const MSG = {
  wrapId: "wrap1",
  from: "Alice <alice@example.com>",
  to: "bob@example.test",
  subject: "Hi",
  messageId: "<m1@example.com>",
  text: "the body",
  raw: "raw",
  seal: {},
  rumor: {},
  receivedAt: 1_700_000_000,
};

describe("mail tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers reads always, writes only with allowWrites", () => {
    const readOnly = register({ allowWrites: false });
    expect([...readOnly.keys()].sort()).toEqual([
      "list_mail",
      "list_mail_aliases",
      "read_mail",
      "who_is_my_mail_address",
    ]);
    const withWrite = register({ allowWrites: true });
    expect(withWrite.size).toBe(7);
    expect(withWrite.has("send_mail")).toBe(true);
  });

  it("list_mail sorts newest-first and reports counts", async () => {
    (mail.readMail as any).mockResolvedValue({
      mail: [{ ...MSG, wrapId: "old", receivedAt: 1 }, { ...MSG, wrapId: "new", receivedAt: 2 }],
      failures: [],
    });
    const tools = register({ allowWrites: false });
    const res = await tools.get("list_mail")!.handler({});
    expect(res.ok).toBe(true);
    expect(res.data.mail.map((m: any) => m.id)).toEqual(["new", "old"]);
    expect(res.data.count).toBe(2);
  });

  it("read_mail returns the body, and a NOT_FOUND for an unknown id", async () => {
    (mail.readMail as any).mockResolvedValue({ mail: [MSG], failures: [] });
    const tools = register({ allowWrites: false });
    const found = await tools.get("read_mail")!.handler({ mailId: "wrap1" });
    expect(found.ok).toBe(true);
    expect(found.text).toContain("the body");
    expect(found.text).toContain("Subject: Hi");

    const missing = await tools.get("read_mail")!.handler({ mailId: "nope" });
    expect(missing.ok).toBe(false);
    expect(missing.errorCode).toBe("NOT_FOUND");
  });

  it("who_is_my_mail_address reports the identity, default and aliases", async () => {
    (mail.mailIdentity as any).mockResolvedValue({
      pubkey: "pk",
      npub: "npub1x",
      nip05: "irona@mailstr.app",
    });
    (mail.listAliases as any).mockResolvedValue(["irona@mailstr.app", "irona@work.dev"]);
    (mail.defaultSenderAddress as any).mockResolvedValue("irona@mailstr.app");
    const tools = register({ allowWrites: false });
    const res = await tools.get("who_is_my_mail_address")!.handler({});
    expect(res.text).toContain("Sending as irona@mailstr.app");
    expect(res.text).toContain("irona@work.dev");
    expect(res.data.aliases).toEqual(["irona@mailstr.app", "irona@work.dev"]);
  });

  it("list_mail_aliases marks the default", async () => {
    (mail.listAliases as any).mockResolvedValue(["irona@mailstr.app", "irona@work.dev"]);
    (mail.defaultSenderAddress as any).mockResolvedValue("irona@work.dev");
    const tools = register({ allowWrites: false });
    const res = await tools.get("list_mail_aliases")!.handler({});
    expect(res.ok).toBe(true);
    expect(res.text).toContain("default is irona@work.dev");
    expect(res.data.aliases).toHaveLength(2);
  });

  it("send_mail requires confirm, then reports per-relay delivery", async () => {
    (mail.sendMail as any).mockResolvedValue({
      recipient: "pk",
      wrap: { id: "w1" },
      results: [
        { relay: "a", ok: true, detail: "" },
        { relay: "b", ok: false, detail: "nope" },
      ],
    });
    const tools = register({ allowWrites: true });

    const blocked = await tools.get("send_mail")!.handler({ to: "npub1x", text: "hi" });
    expect(blocked.ok).toBe(false);
    expect(blocked.text).toContain("Confirmation required");
    expect(mail.sendMail).not.toHaveBeenCalled();

    const sent = await tools.get("send_mail")!.handler({
      to: "npub1x",
      text: "hi",
      confirm: true,
    });
    expect(sent.ok).toBe(true);
    expect(sent.text).toContain("1/2 relay");
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "npub1x", text: "hi" }),
    );
  });

  it("send_mail rejects without text or raw", async () => {
    (mail.mailIdentity as any).mockResolvedValue({ pubkey: "pk", npub: "npub1x", nip05: null });
    (mail.listAliases as any).mockResolvedValue([]);
    const tools = register({ allowWrites: true });
    const res = await tools.get("send_mail")!.handler({ to: "npub1x", confirm: true });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("BAD_INPUT");
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("send_mail rejects a From the key does not own, naming valid senders", async () => {
    (mail.mailIdentity as any).mockResolvedValue({ pubkey: "pk", npub: "npub1x", nip05: null });
    (mail.listAliases as any).mockResolvedValue(["irona@mailstr.app"]);
    const tools = register({ allowWrites: true });
    const res = await tools.get("send_mail")!.handler({
      to: "someone@example.com",
      text: "hi",
      from: "stranger@mailstr.app",
      confirm: true,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe("BAD_SENDER");
    expect(res.text).toContain("irona@mailstr.app");
    expect(mail.sendMail).not.toHaveBeenCalled();
  });

  it("send_mail accepts an owned alias as From", async () => {
    (mail.mailIdentity as any).mockResolvedValue({ pubkey: "pk", npub: "npub1x", nip05: null });
    (mail.listAliases as any).mockResolvedValue(["irona@mailstr.app", "irona@work.dev"]);
    (mail.sendMail as any).mockResolvedValue({
      recipient: "pk",
      wrap: { id: "w1" },
      results: [{ relay: "a", ok: true, detail: "" }],
    });
    const tools = register({ allowWrites: true });
    const res = await tools.get("send_mail")!.handler({
      to: "npub1y",
      text: "hi",
      from: "irona@work.dev",
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(mail.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "irona@work.dev" }),
    );
  });

  it("claim_mailbox returns a bolt11 invoice and never pays it", async () => {
    (mail.requestMailbox as any).mockResolvedValue({
      invoice: "lnbc1...",
      paymentHash: "h",
      amountSats: 21,
      nip05: "irona@mailstr.app",
    });
    const tools = register({ allowWrites: true });
    const blocked = await tools.get("claim_mailbox")!.handler({ name: "irona" });
    expect(blocked.text).toContain("Confirmation required");

    const res = await tools.get("claim_mailbox")!.handler({ name: "irona", confirm: true });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("21 sats");
    expect(res.data.invoice).toBe("lnbc1...");
  });

  it("publish_mail_setup reports both event outcomes", async () => {
    (mail.publishMailSetup as any).mockResolvedValue({
      profile: { eventId: "e1", results: [{ relay: "a", ok: true }] },
      dmRelays: { eventId: "e2", results: [{ relay: "a", ok: true }, { relay: "b", ok: false }] },
    });
    const tools = register({ allowWrites: true });
    const res = await tools.get("publish_mail_setup")!.handler({
      name: "irona",
      nip05: "irona@mailstr.app",
      confirm: true,
    });
    expect(res.ok).toBe(true);
    expect(res.text).toContain("profile to 1 relay");
    expect(res.text).toContain("relay list to 1 relay");
  });
});
