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

describe("KanbanSDK private surface", () => {
  it("routes createBoard by the private flag", async () => {
    const runtime = new FakeRuntime();
    const sdk = new KanbanSDK({ signer: fakeSigner(), runtime, relays: ["wss://test.relay/"] });

    const publicBoard = await sdk.createBoard({ title: "Public", columns: [] });
    const privateBoard = await sdk.createBoard({ title: "Private", columns: [], private: true });

    expect(publicBoard.isPrivate).toBe(false);
    expect(privateBoard.isPrivate).toBe(true);
    expect(runtime.published.some((e) => e.kind === 30301)).toBe(true);
    expect(runtime.published.some((e) => e.kind === 32301)).toBe(true);
  });

  it("refuses a private coordinate with no view key", async () => {
    const sdk = new KanbanSDK({ signer: fakeSigner(), runtime: new FakeRuntime() });
    expect(() => sdk.fetchBoardByCoordinate(`32301:${"c".repeat(64)}:x`)).toThrow(/No view key/);
  });

  it("still throws SignerRequiredError for private reads without a signer", async () => {
    const sdk = new KanbanSDK({ runtime: new FakeRuntime() });
    await expect(sdk.fetchPrivateBoards()).rejects.toThrow(/requires a signer/);
  });
});
