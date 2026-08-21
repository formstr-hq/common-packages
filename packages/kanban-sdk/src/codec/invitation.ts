import { KANBAN_KINDS } from "../kinds";
import type { BoardInvitation, BoardRole } from "../types";

import { normalizeBoardRole } from "./role";

/**
 * Invitation rumor (kind 53) codec — doc 05 §6.
 *
 * The rumor rides inside a NIP-59 seal and wrap; this codec only shapes and reads
 * its tags. Verifying that the wrap is authentic is `crypto/nip59.unwrapEvent`'s
 * job and MUST happen before anything here is trusted — the tags below carry a key
 * the recipient will act on.
 */

export function buildInvitationRumorTags(ref: {
  coordinate: string;
  relayHint: string;
  viewKey: string;
  role: BoardRole;
  /**
   * nsec of the ephemeral key this wrap is signed with. Handing it to the
   * recipient is what lets them delete the wrap: NIP-09 only honours a deletion
   * from the target's own author, and the wrap's author is this throwaway key.
   * Safe to share — it signs one wrap and nothing else, and the seal inside is
   * signed by the inviter's real key, so it cannot be used to forge an
   * invitation from them.
   */
  signingNsec?: string;
}): string[][] {
  const tags: string[][] = [
    ["a", ref.coordinate, ref.relayHint],
    ["viewKey", ref.viewKey],
    ["role", ref.role],
  ];
  if (ref.signingNsec) tags.push(["signing_nsec", ref.signingNsec]);
  return tags;
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

  const claimed = rumor.tags.find((t) => t[0] === "role")?.[1];

  return {
    coordinate,
    relayHint: aTag?.[2] ?? "",
    viewKey,
    role: normalizeBoardRole(claimed),
    inviterPubkey: rumor.pubkey,
    message: rumor.content ?? "",
    wrapId,
    createdAt: rumor.created_at,
    // Absent on invitations sent before this field existed; dismissal falls
    // back to the kind-84 opt-out for those.
    signingNsec: rumor.tags.find((t) => t[0] === "signing_nsec")?.[1],
  };
}
