import { finalizeEvent, generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { fakeSigner, makeCtx } from "../../test/helpers";
import { KANBAN_KINDS } from "../kinds";
import type { BoardListRef } from "../types";
import {
  addBoardToList,
  createBoardList,
  ensureBoardList,
  fetchBoardLists,
  lookupBoardViewKey,
  removeBoardFromList,
} from "./boardLists";

const COORDINATE = `32301:${"c".repeat(64)}:board-d`;

const ref = (overrides: Partial<BoardListRef> = {}): BoardListRef => ({
  coordinate: COORDINATE,
  relayHint: "wss://test.relay/",
  viewKey: "nsec1aaa",
  role: "owner",
  ...overrides,
});

describe("createBoardList", () => {
  it("publishes an encrypted 32303 whose content leaks nothing", async () => {
    const ctx = makeCtx();
    const list = await createBoardList(ctx, "Work");

    const [event] = ctx.runtime.published;
    expect(event.kind).toBe(KANBAN_KINDS.boardList);
    expect(event.tags).toEqual([["d", list.id]]);
    expect(event.content).not.toContain("Work");
    expect(list.title).toBe("Work");
    expect(list.boards).toEqual([]);
  });

  it("defaults the title", async () => {
    const list = await createBoardList(makeCtx());
    expect(list.title).toBe("My Boards");
  });
});

describe("fetchBoardLists", () => {
  it("self-decrypts the author's own lists", async () => {
    const ctx = makeCtx();
    await createBoardList(ctx, "Work");
    const lists = await fetchBoardLists(ctx);
    expect(lists.map((l) => l.title)).toEqual(["Work"]);
  });

  it("hydrates createdAt from the wire event so the next update supersedes it", async () => {
    const ctx = makeCtx();
    await createBoardList(ctx, "Work");
    const [list] = await fetchBoardLists(ctx);
    expect(list.createdAt).toBe(ctx.runtime.published[0].created_at);
  });

  it("skips an undecryptable list of our own rather than hiding every other board", async () => {
    const secret = generateSecretKey();
    const ctx = makeCtx({ signer: fakeSigner(secret) });
    await createBoardList(ctx, "Mine");

    // Same author, so it passes the relay filter, but the content was encrypted
    // under a key we do not hold. One corrupt list must not abort the load.
    ctx.runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.boardList,
          created_at: Math.floor(Date.now() / 1000),
          tags: [["d", "corrupt"]],
          content: "not-a-nip44-payload",
        },
        secret,
      ),
    );

    const lists = await fetchBoardLists(ctx);
    expect(lists.map((l) => l.title)).toEqual(["Mine"]);
  });
});

describe("addBoardToList", () => {
  it("links a board and republishes with a strictly newer created_at", async () => {
    const ctx = makeCtx();
    const list = await createBoardList(ctx, "Work");
    const updated = await addBoardToList(ctx, list, ref());

    expect(updated.boards).toEqual([ref()]);
    expect(updated.createdAt).toBeGreaterThan(list.createdAt);
    expect(await lookupBoardViewKey(ctx, COORDINATE)).toBe("nsec1aaa");
  });

  it("is a no-op when the same ref is already present", async () => {
    const ctx = makeCtx();
    const list = await addBoardToList(ctx, await createBoardList(ctx, "Work"), ref());
    const before = ctx.runtime.published.length;

    const again = await addBoardToList(ctx, list, ref());
    expect(ctx.runtime.published).toHaveLength(before);
    expect(again.boards).toHaveLength(1);
  });

  it("replaces a stale view key — the ref is the only home a rotated key has", async () => {
    const ctx = makeCtx();
    const list = await addBoardToList(ctx, await createBoardList(ctx, "Work"), ref());
    await addBoardToList(ctx, list, ref({ viewKey: "nsec1bbb" }));

    expect(await lookupBoardViewKey(ctx, COORDINATE)).toBe("nsec1bbb");
  });

  it("never clobbers a stored key with an empty one", async () => {
    const ctx = makeCtx();
    const list = await addBoardToList(ctx, await createBoardList(ctx, "Work"), ref());
    await addBoardToList(ctx, list, ref({ viewKey: "" }));

    expect(await lookupBoardViewKey(ctx, COORDINATE)).toBe("nsec1aaa");
  });
});

describe("removeBoardFromList", () => {
  it("drops the ref and republishes", async () => {
    const ctx = makeCtx();
    const list = await addBoardToList(ctx, await createBoardList(ctx, "Work"), ref());
    const updated = await removeBoardFromList(ctx, list, COORDINATE);

    expect(updated.boards).toEqual([]);
    expect(await lookupBoardViewKey(ctx, COORDINATE)).toBeUndefined();
  });
});

describe("ensureBoardList", () => {
  it("auto-creates 'My Boards' when the user has none", async () => {
    const ctx = makeCtx();
    const list = await ensureBoardList(ctx);
    expect(list.title).toBe("My Boards");
  });

  it("returns the named list when it resolves", async () => {
    const ctx = makeCtx();
    const named = await createBoardList(ctx, "Work");
    expect((await ensureBoardList(ctx, named.id)).id).toBe(named.id);
  });

  it("falls back to an existing list when the named one does not resolve, rather than skipping the link", async () => {
    const ctx = makeCtx();
    const existing = await createBoardList(ctx, "Work");
    const resolved = await ensureBoardList(ctx, "no-such-list");
    expect(resolved.id).toBe(existing.id);
  });
});
