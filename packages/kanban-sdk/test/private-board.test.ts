import { generateSecretKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { KanbanSDK } from "../src/KanbanSDK";
import { KANBAN_KINDS } from "../src/kinds";
import { FakeRuntime, fakeSigner } from "./helpers";

/**
 * One signer, reusable across SDK instances: the point of several tests below is
 * that a SECOND SDK for the same identity recovers everything from relays alone.
 */
function makeSdk(runtime = new FakeRuntime(), signer = fakeSigner(generateSecretKey())) {
  return {
    sdk: new KanbanSDK({ signer, runtime, relays: ["wss://test.relay/"] }),
    runtime,
    signer,
  };
}

describe("private board lifecycle", () => {
  it("creates, reads back, edits, and deletes a private board through the facade", async () => {
    const { sdk, runtime, signer } = makeSdk();

    const board = await sdk.createBoard({
      title: "Q3 Roadmap",
      description: "Everything we ship",
      columns: [
        { id: "col-1", name: "To Do", order: 0 },
        { id: "col-2", name: "Done", order: 1 },
      ],
      private: true,
    });
    expect(board.isPrivate).toBe(true);

    const card = await sdk.createCard(board, { title: "Ship the SDK", status: "col-1" });
    expect(card.status).toBe("col-1");

    // A fresh SDK over the same relay and the same identity key, holding no
    // in-memory state from the first: everything must come back from the board
    // list alone. This is the test that would fail if a board were left unlisted.
    const reopened = new KanbanSDK({ signer, runtime, relays: ["wss://test.relay/"] });
    const [recovered] = await reopened.fetchPrivateBoards();
    expect(recovered.title).toBe("Q3 Roadmap");
    expect(recovered.viewKey).toBe(board.viewKey);

    const cards = await reopened.fetchCards(recovered);
    expect(cards.map((c) => c.title)).toEqual(["Ship the SDK"]);

    const renamed = await reopened.updateBoard(recovered, {
      columns: [
        { id: "col-1", name: "Backlog", order: 0 },
        { id: "col-2", name: "Done", order: 1 },
      ],
    });
    // Renaming a column must not orphan a card: `s` holds the id.
    const afterRename = await reopened.fetchCards(renamed);
    expect(afterRename[0].status).toBe("col-1");
    expect(renamed.columns[0].name).toBe("Backlog");

    await reopened.deleteBoard(renamed);
    expect(await reopened.fetchPrivateBoards()).toEqual([]);
  });

  it("leaks nothing but d tags and an opaque pointer to the relay", async () => {
    const { sdk, runtime } = makeSdk();
    const board = await sdk.createBoard({
      title: "Acquisition of Foo Corp",
      columns: [{ id: "col-1", name: "Legal review", order: 0 }],
      participants: ["a".repeat(64)],
      private: true,
    });
    await sdk.createCard(board, { title: "Draft the term sheet", status: "col-1" });

    const secrets = ["Acquisition", "Foo Corp", "Legal review", "term sheet", "a".repeat(64)];
    for (const event of runtime.published) {
      for (const secret of secrets) {
        expect(JSON.stringify(event.tags)).not.toContain(secret);
        expect(event.content).not.toContain(secret);
      }
    }

    const boardEvent = runtime.published.find((e) => e.kind === KANBAN_KINDS.privateBoard)!;
    const cardEvent = runtime.published.find((e) => e.kind === KANBAN_KINDS.privateCard)!;
    expect(boardEvent.tags.map((t) => t[0])).toEqual(["d"]);
    expect(cardEvent.tags.map((t) => t[0]).sort()).toEqual(["b", "d"]);
  });

  it("keeps two boards under one identity unlinkable to a relay", async () => {
    const { sdk, runtime } = makeSdk();
    const first = await sdk.createBoard({ title: "One", columns: [], private: true });
    const second = await sdk.createBoard({ title: "Two", columns: [], private: true });
    await sdk.createCard(first, { title: "a" });
    await sdk.createCard(second, { title: "b" });

    const pointers = runtime.published
      .filter((e) => e.kind === KANBAN_KINDS.privateCard)
      .map((e) => e.tags.find((t) => t[0] === "b")![1]);
    expect(new Set(pointers).size).toBe(2);
  });

  it("a public board still writes kanbanstr's wire format through the same method", async () => {
    const { sdk, runtime } = makeSdk();
    const board = await sdk.createBoard({
      title: "Open Source Roadmap",
      columns: [{ id: "col-1", name: "To Do", order: 0 }],
    });
    await sdk.createCard(board, { title: "Public task", status: "To Do" });

    const boardEvent = runtime.published.find((e) => e.kind === KANBAN_KINDS.publicBoard)!;
    expect(boardEvent.tags).toContainEqual(["title", "Open Source Roadmap"]);
    expect(board.isPrivate).toBe(false);
  });
});
