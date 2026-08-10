import { describe, expect, it } from "vitest";

import { buildInvitationRumorTags, parseInvitationRumor } from "./invitation";

const COORDINATE = `32301:${"c".repeat(64)}:board-d`;
const INVITER = "a".repeat(64);

const rumor = (tags: string[][], overrides: Record<string, unknown> = {}) => ({
  kind: 53,
  pubkey: INVITER,
  created_at: 1753600000,
  tags,
  content: "",
  ...overrides,
});

describe("buildInvitationRumorTags", () => {
  it("emits the doc 05 §6 rumor tags", () => {
    expect(
      buildInvitationRumorTags({
        coordinate: COORDINATE,
        relayHint: "wss://relay.example/",
        viewKey: "nsec1aaa",
        role: "maintainer",
      }),
    ).toEqual([
      ["a", COORDINATE, "wss://relay.example/"],
      ["viewKey", "nsec1aaa"],
      ["role", "maintainer"],
    ]);
  });
});

describe("parseInvitationRumor", () => {
  it("reads the coordinate, key, role, and inviter", () => {
    const tags = buildInvitationRumorTags({
      coordinate: COORDINATE,
      relayHint: "wss://relay.example/",
      viewKey: "nsec1aaa",
      role: "maintainer",
    });
    const invitation = parseInvitationRumor(rumor(tags, { content: "join us" }), "w".repeat(64));

    expect(invitation).toEqual({
      coordinate: COORDINATE,
      relayHint: "wss://relay.example/",
      viewKey: "nsec1aaa",
      role: "maintainer",
      inviterPubkey: INVITER,
      message: "join us",
      wrapId: "w".repeat(64),
      createdAt: 1753600000,
    });
  });

  it("rejects a rumor of the wrong kind", () => {
    const tags = buildInvitationRumorTags({
      coordinate: COORDINATE,
      relayHint: "",
      viewKey: "nsec1aaa",
      role: "member",
    });
    expect(parseInvitationRumor(rumor(tags, { kind: 1 }), "w")).toBeNull();
  });

  it("rejects an invitation with no view key — there is nothing to accept", () => {
    expect(parseInvitationRumor(rumor([["a", COORDINATE, ""]]), "w")).toBeNull();
  });

  it("rejects an invitation whose coordinate is not a private board", () => {
    const tags = [
      ["a", `30301:${"c".repeat(64)}:board-d`, ""],
      ["viewKey", "nsec1aaa"],
    ];
    expect(parseInvitationRumor(rumor(tags), "w")).toBeNull();
  });

  it("defaults an absent or unrecognised role to member", () => {
    const base = [
      ["a", COORDINATE, ""],
      ["viewKey", "nsec1aaa"],
    ];
    expect(parseInvitationRumor(rumor(base), "w")!.role).toBe("member");
    expect(parseInvitationRumor(rumor([...base, ["role", "admin"]]), "w")!.role).toBe("member");
  });
});
