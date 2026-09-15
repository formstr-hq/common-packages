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
        role: "participant",
      }),
    ).toEqual([
      ["a", COORDINATE, "wss://relay.example/"],
      ["viewKey", "nsec1aaa"],
      ["role", "participant"],
    ]);
  });
});

describe("parseInvitationRumor", () => {
  it("reads the coordinate, key, role, and inviter", () => {
    const tags = buildInvitationRumorTags({
      coordinate: COORDINATE,
      relayHint: "wss://relay.example/",
      viewKey: "nsec1aaa",
      role: "participant",
    });
    const invitation = parseInvitationRumor(rumor(tags, { content: "join us" }), "w".repeat(64));

    expect(invitation).toEqual({
      coordinate: COORDINATE,
      relayHint: "wss://relay.example/",
      viewKey: "nsec1aaa",
      role: "participant",
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
      role: "participant",
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

  it("defaults an absent or unrecognised role to participant", () => {
    const base = [
      ["a", COORDINATE, ""],
      ["viewKey", "nsec1aaa"],
    ];
    expect(parseInvitationRumor(rumor(base), "w")!.role).toBe("participant");
    expect(parseInvitationRumor(rumor([...base, ["role", "superuser"]]), "w")!.role).toBe(
      "participant",
    );
  });
});

describe("legacy roles on the wire", () => {
  it("reads an invitation sent by 0.1.x as a participant", () => {
    const tags = buildInvitationRumorTags({
      coordinate: COORDINATE,
      relayHint: "",
      viewKey: "nsec1aaa",
      role: "participant",
    });
    // What a 0.1.x client actually wrote. The role is advisory either way: the
    // board's own tags decide what the invitee may do once they accept.
    const legacy = tags.map((t) => (t[0] === "role" ? ["role", "maintainer"] : t));
    expect(parseInvitationRumor(rumor(legacy), "w".repeat(64))?.role).toBe("participant");
  });
});
