import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner } from "../test/helpers";
import { KanbanSDK } from "./KanbanSDK";
import { SignerRequiredError } from "./contracts";

describe("KanbanSDK", () => {
  it("throws SignerRequiredError for writes without a signer", async () => {
    const sdk = new KanbanSDK({ runtime: new FakeRuntime() });
    await expect(sdk.createBoard({ title: "X", columns: [] })).rejects.toBeInstanceOf(
      SignerRequiredError,
    );
  });

  it("reads public boards without a signer", async () => {
    const runtime = new FakeRuntime();
    const writer = new KanbanSDK({ signer: fakeSigner(), runtime });
    const board = await writer.createBoard({ title: "Public", columns: [] });

    const reader = new KanbanSDK({ runtime });
    const boards = await reader.fetchBoards({ authors: [board.pubkey] });
    expect(boards.map((b) => b.title)).toEqual(["Public"]);
  });

  it("exposes its relay set", () => {
    const sdk = new KanbanSDK({ runtime: new FakeRuntime(), relays: ["wss://a.example/"] });
    expect(sdk.relays).toEqual(["wss://a.example/"]);
  });

  it("creates a board and a card end to end", async () => {
    const sdk = new KanbanSDK({ signer: fakeSigner(), runtime: new FakeRuntime() });
    const board = await sdk.createBoard({
      title: "Roadmap",
      columns: [{ id: "c1", name: "To Do", order: 0 }],
    });
    await sdk.createCard(board, { title: "Ship it", status: "To Do" });

    const cards = await sdk.fetchCards(board);
    expect(cards.map((c) => c.title)).toEqual(["Ship it"]);
  });
});
