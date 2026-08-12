import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { describe, expect, it } from "vitest";

import { FakeRuntime, fakeSigner, makeCtx } from "../../test/helpers";
import { encryptWithViewKey } from "../crypto/viewKey";
import { KANBAN_KINDS } from "../kinds";
import { createPrivateBoard } from "./boards";
import { boardPointer, createPrivateCard } from "./cards";
import { canComment, createComment, deleteComment, fetchComments, updateComment } from "./comments";

async function fixture() {
  const runtime = new FakeRuntime();
  const alice = makeCtx({ signer: fakeSigner(generateSecretKey()), runtime });
  const memberSecret = generateSecretKey();
  const { board } = await createPrivateBoard(alice, {
    title: "Q3",
    columns: [{ id: "col-1", name: "To Do", order: 0 }],
    members: [getPublicKey(memberSecret)],
    private: true,
  });
  const card = await createPrivateCard(alice, board, { title: "Ship it", status: "col-1" });
  const member = makeCtx({ signer: fakeSigner(memberSecret), runtime });
  return { runtime, alice, member, memberSecret, board, card };
}

describe("canComment", () => {
  it("admits the owner, maintainers, and members", async () => {
    const { board, memberSecret } = await fixture();
    expect(canComment(board, board.pubkey)).toBe(true);
    expect(canComment(board, getPublicKey(memberSecret))).toBe(true);
    expect(canComment(board, "9".repeat(64))).toBe(false);
  });
});

describe("createComment", () => {
  it("publishes a 32304 carrying only d and b", async () => {
    const { runtime, alice, board, card } = await fixture();
    await createComment(alice, board, card.id, { content: "shipping Friday" });

    const event = runtime.published.find((e) => e.kind === KANBAN_KINDS.privateComment)!;
    expect(event.tags.map((t) => t[0]).sort()).toEqual(["b", "d"]);
    expect(event.content).not.toContain("shipping Friday");
  });

  it("reuses the card's blinded pointer so both arrive in one fetch", async () => {
    const { runtime, alice, board, card } = await fixture();
    await createComment(alice, board, card.id, { content: "x" });

    const cardEvent = runtime.published.find((e) => e.kind === KANBAN_KINDS.privateCard)!;
    const commentEvent = runtime.published.find((e) => e.kind === KANBAN_KINDS.privateComment)!;
    expect(commentEvent.tags.find((t) => t[0] === "b")![1]).toBe(
      cardEvent.tags.find((t) => t[0] === "b")![1],
    );
  });

  it("lets a read-only member comment", async () => {
    const { member, board, card } = await fixture();
    const comment = await createComment(member, board, card.id, { content: "from a member" });
    expect(comment.content).toBe("from a member");
  });

  it("refuses someone with no role on the board", async () => {
    const { runtime, board, card } = await fixture();
    const stranger = makeCtx({ signer: fakeSigner(), runtime });
    await expect(createComment(stranger, board, card.id, { content: "nope" })).rejects.toThrow(
      /cannot comment/,
    );
  });
});

describe("fetchComments", () => {
  it("returns comments oldest first", async () => {
    const { alice, board, card } = await fixture();
    await createComment(alice, board, card.id, { content: "first" });
    await createComment(alice, board, card.id, { content: "second" });

    const contents = (await fetchComments(alice, board, card.id)).map((c) => c.content);
    expect(contents.sort()).toEqual(["first", "second"]);
  });

  it("filters to one card when asked, and returns the board's comments otherwise", async () => {
    const { alice, board, card } = await fixture();
    const other = await createPrivateCard(alice, board, { title: "Other", status: "col-1" });
    await createComment(alice, board, card.id, { content: "on card" });
    await createComment(alice, board, other.id, { content: "on other" });

    expect((await fetchComments(alice, board, card.id)).map((c) => c.content)).toEqual(["on card"]);
    expect(
      (await fetchComments(alice, board)).map((c) => c.content).sort(),
    ).toEqual(["on card", "on other"]);
  });

  it("discards a comment whose inner a tag points at another board", async () => {
    const { runtime, alice, board, card } = await fixture();
    await createComment(alice, board, card.id, { content: "legit" });

    const stranger = generateSecretKey();
    runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateComment,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "crossposted"],
            ["b", boardPointer(board, board.viewKey!)],
          ],
          content: await encryptWithViewKey(
            board.viewKey!,
            JSON.stringify([
              ["d", "crossposted"],
              ["a", `32301:${"9".repeat(64)}:elsewhere`],
              ["e", card.id],
              ["content", "crossposted"],
            ]),
          ),
        },
        stranger,
      ),
    );

    expect((await fetchComments(alice, board, card.id)).map((c) => c.content)).toEqual(["legit"]);
  });

  it("discards a comment from someone with no role on the board", async () => {
    const { runtime, alice, board, card } = await fixture();
    await createComment(alice, board, card.id, { content: "legit" });

    const outsider = generateSecretKey();
    runtime.seed(
      finalizeEvent(
        {
          kind: KANBAN_KINDS.privateComment,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["d", "injected"],
            ["b", boardPointer(board, board.viewKey!)],
          ],
          content: await encryptWithViewKey(
            board.viewKey!,
            JSON.stringify([
              ["d", "injected"],
              ["a", `32301:${board.pubkey}:${board.id}`],
              ["e", card.id],
              ["content", "injected"],
            ]),
          ),
        },
        outsider,
      ),
    );

    expect((await fetchComments(alice, board, card.id)).map((c) => c.content)).toEqual(["legit"]);
  });
});

describe("updateComment", () => {
  it("republishes under the same d and strictly supersedes", async () => {
    const { alice, board, card } = await fixture();
    const comment = await createComment(alice, board, card.id, { content: "draft" });
    const edited = await updateComment(alice, board, comment, { content: "final" });

    expect(edited.id).toBe(comment.id);
    expect(edited.createdAt).toBeGreaterThan(comment.createdAt);
    expect((await fetchComments(alice, board, card.id)).map((c) => c.content)).toEqual(["final"]);
  });
});

describe("deleteComment", () => {
  it("removes it from later fetches", async () => {
    const { alice, board, card } = await fixture();
    const comment = await createComment(alice, board, card.id, { content: "oops" });
    await deleteComment(alice, comment);

    expect(await fetchComments(alice, board, card.id)).toEqual([]);
  });

  it("refuses to tombstone a comment the signer did not write", async () => {
    const { alice, member, board, card } = await fixture();
    const comment = await createComment(member, board, card.id, { content: "mine" });

    await expect(deleteComment(alice, comment)).rejects.toThrow(/did not sign/i);
    expect((await fetchComments(alice, board, card.id)).map((c) => c.content)).toEqual(["mine"]);
  });
});
