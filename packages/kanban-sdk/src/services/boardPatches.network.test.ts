import { generateSecretKey, getPublicKey } from "nostr-tools";
import { beforeEach, describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import type { KanbanCtx } from "../contracts";
import { KANBAN_KINDS } from "../kinds";
import type { KanbanBoard } from "../types";

import { fetchPatches, foldPatches, publicBoardRef, publishPatch } from "./boardPatches";

const creatorSecret = generateSecretKey();
const adminSecret = generateSecretKey();
const CREATOR = getPublicKey(creatorSecret);
const ADMIN = getPublicKey(adminSecret);

let runtime: FakeRuntime;
let adminCtx: KanbanCtx;

function board(overrides: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: "board-1",
    pubkey: CREATOR,
    eventId: "evt",
    title: "Roadmap",
    description: "",
    columns: [{ id: "todo", name: "To Do", order: 0 }],
    admins: [ADMIN],
    participants: [],
    legacyViewers: [],
    baked: 0,
    noZap: false,
    createdAt: 100,
    isPrivate: false,
    legacy: false,
    rawTags: [],
    ...overrides,
  };
}

const target = (b: KanbanBoard) => ({
  ref: publicBoardRef(b),
  admins: b.admins,
  isPrivate: false,
});

beforeEach(() => {
  runtime = new FakeRuntime();
  adminCtx = makeCtx({ signer: fakeSigner(adminSecret), runtime });
});

describe("publishPatch", () => {
  it("publishes at the admin's own coordinate, never the board's", async () => {
    const base = board();
    await publishPatch(adminCtx, base, publicBoardRef(base), { title: "Renamed" });

    const [event] = runtime.published;
    expect(event.kind).toBe(KANBAN_KINDS.adminPatch);
    expect(event.pubkey).toBe(ADMIN);
    expect(event.tags).toContainEqual(["d", publicBoardRef(base)]);
  });

  it("round-trips through fetch and fold", async () => {
    const base = board();
    await publishPatch(adminCtx, base, publicBoardRef(base), {
      columns: [{ id: "blocked", name: "Blocked", order: 1 }],
    });

    const patches = await fetchPatches(adminCtx, [target(base)]);
    const folded = foldPatches(base, patches.get(publicBoardRef(base)) ?? [], publicBoardRef(base));

    expect(folded.columns.map((c) => c.id)).toEqual(["todo", "blocked"]);
  });

  it("keeps the admin's earlier edit when they make a second one", async () => {
    const base = board();
    const ref = publicBoardRef(base);
    await publishPatch(adminCtx, base, ref, { title: "Renamed" });
    await publishPatch(adminCtx, base, ref, {
      columns: [{ id: "blocked", name: "Blocked", order: 1 }],
    });

    const folded = foldPatches(base, (await fetchPatches(adminCtx, [target(base)])).get(ref) ?? [], ref);

    // The patch is replaceable: without the merge, the second publish would have
    // dropped the rename outright.
    expect(folded.title).toBe("Renamed");
    expect(folded.columns.map((c) => c.id)).toEqual(["todo", "blocked"]);
  });

  it("writes past a bake, so a fresh edit is not born inert", async () => {
    // nextCreatedAt would otherwise hand back "now", which on a board baked this
    // same second is not strictly after the watermark.
    const baked = Math.floor(Date.now() / 1000) + 60;
    const base = board({ baked });
    const ref = publicBoardRef(base);

    await publishPatch(adminCtx, base, ref, { title: "Fresh" });
    const folded = foldPatches(base, (await fetchPatches(adminCtx, [target(base)])).get(ref) ?? [], ref);

    expect(folded.title).toBe("Fresh");
  });

  it("refuses to patch a board the caller does not administer", async () => {
    const stranger = makeCtx({ signer: fakeSigner(generateSecretKey()), runtime });
    await expect(
      publishPatch(stranger, board(), publicBoardRef(board()), { title: "Nope" }),
    ).rejects.toThrow(/not an admin/i);
  });
});

describe("fetchPatches", () => {
  it("returns nothing for a board with no admins, without querying", async () => {
    const base = board({ admins: [] });
    const patches = await fetchPatches(adminCtx, [
      { ref: publicBoardRef(base), admins: [], isPrivate: false },
    ]);
    expect(patches.size).toBe(0);
  });

  it("ignores a patch signed by someone the board does not list", async () => {
    const base = board();
    const ref = publicBoardRef(base);
    const impostor = makeCtx({ signer: fakeSigner(generateSecretKey()), runtime });

    // Published against a board that does list them, so the write itself is legal.
    await publishPatch(impostor, board({ admins: [await (await impostor.getSigner()).getPublicKey()] }), ref, {
      title: "Hijacked",
    });

    const patches = await fetchPatches(adminCtx, [target(base)]);
    expect(patches.get(ref) ?? []).toEqual([]);
  });

  it("keeps one board's patches out of another's bucket", async () => {
    const one = board();
    const two = board({ id: "board-2" });
    await publishPatch(adminCtx, one, publicBoardRef(one), { title: "One" });
    await publishPatch(adminCtx, two, publicBoardRef(two), { title: "Two" });

    const patches = await fetchPatches(adminCtx, [target(one), target(two)]);
    expect(patches.get(publicBoardRef(one))?.[0].title).toBe("One");
    expect(patches.get(publicBoardRef(two))?.[0].title).toBe("Two");
  });
});
