import { KANBAN_KINDS } from "../kinds";
import type { BoardInvitation, BoardRole } from "../types";

/**
 * Invitation rumor (kind 53) codec — doc 05 §6.
 *
 * The rumor rides inside a NIP-59 seal and wrap; this codec only shapes and reads
 * its tags. Verifying that the wrap is authentic is `crypto/nip59.unwrapEvent`'s
 * job and MUST happen before anything here is trusted — the tags below carry a key
 * the recipient will act on.
 */

const ROLES: readonly BoardRole[] = ["owner", "maintainer", "member"];

export function buildInvitationRumorTags(ref: {
  coordinate: string;
  relayHint: string;
  viewKey: string;
  role: BoardRole;
}): string[][] {
  return [
    ["a", ref.coordinate, ref.relayHint],
    ["viewKey", ref.viewKey],
    ["role", ref.role],
  ];
}

export function parseInvitationRumor(
  rumor: { kind: number; pubkey: string; created_at: number; tags: string[][]; content: string },
  wrapId: string,
): BoardInvitation | null {
  if (rumor.kind !== KANBAN_KINDS.inviteRumor) return null;

  const aTag = rumor.tags.find((t) => t[0] === "a");
  const coordinate = aTag?.[1];
  if (!coordinate) return null;

  // Only a private board can be invited to: a public board needs no key, and a
  // coordinate of some other kind means this wrap is not ours to act on.
  if (!coordinate.startsWith(`${KANBAN_KINDS.privateBoard}:`)) return null;

  const viewKey = rumor.tags.find((t) => t[0] === "viewKey")?.[1];
  // An invitation without a key is not an invitation — there is nothing to accept.
  if (!viewKey) return null;

  const claimed = rumor.tags.find((t) => t[0] === "role")?.[1] as BoardRole | undefined;

  return {
    coordinate,
    relayHint: aTag?.[2] ?? "",
    viewKey,
    role: claimed && ROLES.includes(claimed) ? claimed : "member",
    inviterPubkey: rumor.pubkey,
    message: rumor.content ?? "",
    wrapId,
    createdAt: rumor.created_at,
  };
}
