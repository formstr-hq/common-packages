import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/services", () => ({
  pages: {
    fetchMyPages: vi.fn(),
    savePage: vi.fn(),
    fetchPage: vi.fn(),
    deletePage: vi.fn(),
    sharePage: vi.fn(),
    fetchSharedPages: vi.fn(),
    setDocTags: vi.fn(),
    fetchDocTags: vi.fn(),
    fetchRoster: vi.fn(),
    enableGroupSharing: vi.fn(),
  },
  pagesComments: {
    fetchPageComments: vi.fn(),
    publishPageComment: vi.fn(),
  },
  pagesSharedDoc: {
    parseRootAddress: vi.fn((address: string) => {
      const [kind, owner, ...rest] = address.split(":");
      if (!owner || rest.length === 0) return null;
      return { kind: Number(kind), owner, d: rest.join(":") };
    }),
  },
  pagesCollab: {
    openCollabSession: vi.fn(),
    getCollabSession: vi.fn(),
    closeCollabSession: vi.fn(),
    listCollabPeers: vi.fn(() => []),
    readCollabMarkdown: vi.fn(() => "# T"),
    appendCollabDocument: vi.fn(),
    replaceCollabDocument: vi.fn(),
    publishCollabSnapshot: vi.fn(),
  },
}));

import { pages, pagesCollab } from "../src/services";
import { pagesTools } from "../src/tools/pages";
import type { ToolCtx } from "../src/tools/types";

type FakeTools = Map<string, { handler: (a: any) => Promise<any> }>;

function fakeServer(): { server: { tools: FakeTools }; tools: FakeTools } {
  const tools: FakeTools = new Map();
  return { server: { tools }, tools };
}

// Replicates the stdio adapter's gating: skip `write` tools unless allowWrites,
// and inject the ctx so the existing single-arg handler call sites still work.
function registerPages(server: { tools: FakeTools }, ctx: ToolCtx) {
  for (const t of pagesTools) {
    if (t.write && !ctx.allowWrites) continue;
    server.tools.set(t.name, { handler: (a: any) => t.handler(a, ctx) });
  }
}

describe("pages tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("registers read + constructive tools without write access", () => {
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    for (const t of [
      "list_pages",
      "get_page",
      "list_shared_pages",
      "get_page_tags",
      "create_page",
      "save_private_note",
      "set_page_tags",
    ]) {
      expect(tools.has(t)).toBe(true);
    }
    // Gated tools are hidden without --allow-writes.
    expect(tools.has("update_page")).toBe(false);
    expect(tools.has("delete_page")).toBe(false);
    expect(tools.has("share_page")).toBe(false);
  });

  it("exposes gated tools when writes are allowed", () => {
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    expect(tools.has("update_page")).toBe(true);
    expect(tools.has("delete_page")).toBe(true);
    expect(tools.has("share_page")).toBe(true);
  });

  it("update_page requires confirm before overwriting the doc", async () => {
    (pages.savePage as any).mockResolvedValue({ address: "33457:pk:abc" });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    const blocked = await tools.get("update_page")!.handler({ docId: "abc", content: "New" });
    expect(blocked.ok).toBe(false);
    expect(pages.savePage).not.toHaveBeenCalled();
    const res = await tools
      .get("update_page")!
      .handler({ docId: "abc", content: "New", confirm: true });
    expect(pages.savePage).toHaveBeenCalledWith(
      expect.objectContaining({ existingId: "abc", content: "New" }),
    );
    expect(res.ok).toBe(true);
  });

  it("create_page folds the title into the markdown and returns the address", async () => {
    (pages.savePage as any).mockResolvedValue({ address: "33457:pk:abc" });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    const res = await tools.get("create_page")!.handler({ title: "Notes", content: "Hi" });
    expect(pages.savePage).toHaveBeenCalledWith({ content: "# Notes\n\nHi" });
    expect(res.data.address).toBe("33457:pk:abc");
  });

  it("get_page fetches by pubkey + docId (+ optional viewKey)", async () => {
    (pages.fetchPage as any).mockResolvedValue({
      address: "33457:pk:abc",
      title: "T",
      content: "# T",
    });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    await tools.get("get_page")!.handler({ pubkey: "pk", docId: "abc", viewKey: "vk" });
    expect(pages.fetchPage).toHaveBeenCalledWith("pk", "abc", "vk");
  });

  it("delete_page requires confirm", async () => {
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    const blocked = await tools.get("delete_page")!.handler({ address: "33457:pk:abc" });
    expect(blocked.ok).toBe(false);
    expect(pages.deletePage).not.toHaveBeenCalled();
    await tools.get("delete_page")!.handler({ address: "33457:pk:abc", confirm: true });
    expect(pages.deletePage).toHaveBeenCalledWith("33457:pk:abc");
  });

  it("share_page returns the nkeys link (with confirm)", async () => {
    (pages.sharePage as any).mockResolvedValue({
      url: "http://x/pages/naddr1#nkeys1",
      viewKey: "vk",
    });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    const res = await tools
      .get("share_page")!
      .handler({ address: "33457:pk:abc", content: "# T", canEdit: false, confirm: true });
    expect(pages.sharePage).toHaveBeenCalledWith(
      expect.objectContaining({ address: "33457:pk:abc", content: "# T", canEdit: false }),
    );
    expect(res.data.url).toContain("#nkeys1");
  });

  it("registers the collab read tools without write access and gates the writers", () => {
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    for (const t of ["get_page_roster", "open_page_collab", "get_page_collab", "close_page_collab"]) {
      expect(tools.has(t)).toBe(true);
    }
    expect(tools.has("edit_page_collab")).toBe(false);
    expect(tools.has("share_page_collab")).toBe(false);

    const withWrites = fakeServer();
    registerPages(withWrites.server, { allowWrites: true });
    expect(withWrites.tools.has("edit_page_collab")).toBe(true);
    expect(withWrites.tools.has("share_page_collab")).toBe(true);
  });

  it("get_page_roster returns the mode and members", async () => {
    (pages.fetchRoster as any).mockResolvedValue({
      v: 2,
      mode: "restricted",
      tags: [],
      members: [{ pubkey: "ed", role: "editor" }],
    });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    const res = await tools
      .get("get_page_roster")!
      .handler({ address: "33457:pk:abc", viewKey: "vk" });
    expect(pages.fetchRoster).toHaveBeenCalledWith("pk", "abc", "vk");
    expect(res.data.mode).toBe("restricted");
    expect(res.data.members).toEqual([{ pubkey: "ed", role: "editor" }]);
  });

  it("open_page_collab seeds from the doc tip and returns the session", async () => {
    (pages.fetchPage as any).mockResolvedValue({ content: "# T", isEncrypted: false });
    (pagesCollab.openCollabSession as any).mockResolvedValue({ id: "33457:pk:abc", room: "room1" });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: false });
    const res = await tools
      .get("open_page_collab")!
      .handler({ address: "33457:pk:abc", viewKey: "vk" });
    expect(pagesCollab.openCollabSession).toHaveBeenCalledWith(
      expect.objectContaining({ address: "33457:pk:abc", viewKey: "vk", seedMarkdown: "# T" }),
    );
    expect(res.data.sessionId).toBe("33457:pk:abc");
  });

  it("edit_page_collab requires confirm, appends, and saves a snapshot", async () => {
    (pagesCollab.getCollabSession as any).mockReturnValue({ id: "33457:pk:abc" });
    (pagesCollab.publishCollabSnapshot as any).mockResolvedValue({ id: "ev1" });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    const blocked = await tools
      .get("edit_page_collab")!
      .handler({ sessionId: "33457:pk:abc", content: "## New" });
    expect(blocked.ok).toBe(false);
    expect(pagesCollab.appendCollabDocument).not.toHaveBeenCalled();

    const res = await tools
      .get("edit_page_collab")!
      .handler({ sessionId: "33457:pk:abc", content: "## New", confirm: true });
    expect(pagesCollab.appendCollabDocument).toHaveBeenCalledWith(
      expect.objectContaining({ id: "33457:pk:abc" }),
      "## New",
    );
    expect(pagesCollab.publishCollabSnapshot).toHaveBeenCalled();
    expect(res.data.savedEventId).toBe("ev1");
  });

  it("edit_page_collab can replace without saving", async () => {
    (pagesCollab.getCollabSession as any).mockReturnValue({ id: "s" });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    await tools.get("edit_page_collab")!.handler({
      sessionId: "s",
      content: "x",
      mode: "replace",
      save: false,
      confirm: true,
    });
    expect(pagesCollab.replaceCollabDocument).toHaveBeenCalled();
    expect(pagesCollab.publishCollabSnapshot).not.toHaveBeenCalled();
  });

  it("share_page_collab requires confirm before re-publishing", async () => {
    (pages.enableGroupSharing as any).mockResolvedValue({
      url: "http://x/pages/naddr1#nkeys1",
      address: "33457:pk:abc",
      viewKey: "vk",
      mode: "restricted",
      members: [],
    });
    const { server, tools } = fakeServer();
    registerPages(server, { allowWrites: true });
    const blocked = await tools
      .get("share_page_collab")!
      .handler({ address: "33457:pk:abc", content: "# T" });
    expect(blocked.ok).toBe(false);
    expect(pages.enableGroupSharing).not.toHaveBeenCalled();

    const res = await tools
      .get("share_page_collab")!
      .handler({ address: "33457:pk:abc", content: "# T", mode: "open", confirm: true });
    expect(pages.enableGroupSharing).toHaveBeenCalledWith(
      expect.objectContaining({ address: "33457:pk:abc", content: "# T", mode: "open" }),
    );
    expect(res.data.url).toContain("#nkeys1");
  });
});
