/**
 * Kanban event-kind registry.
 *
 * Public kinds (30301/30302) come from NIP PR #1665. They are NOT registered in
 * nips/README.md — see kanban/docs/07-gaps-risks.md §A1. Keep every number here
 * so a forced renumber is a one-file change.
 *
 * Private kinds (32301-32304, 1053/53) are specified in
 * kanban/docs/05-private-kanban-spec.md and land in Plan 2. They are declared
 * now so the registry is complete and the duplicate check is meaningful.
 */
export const KANBAN_KINDS = {
  // NIP-100 public
  publicBoard: 30301,
  publicCard: 30302,

  // NIP-100E private (Plan 2)
  privateBoard: 32301,
  privateCard: 32302,
  boardList: 32303,
  privateComment: 32304,
  inviteGiftWrap: 1053,
  inviteRumor: 53,
  membershipRemoval: 84,

  // Borrowed from other NIPs
  deletion: 5,
  seal: 13,
  relayList: 10002,
  publicComment: 1111,

  // Tracker-card targets (NIP-34)
  gitIssue: 1621,
  gitPatch: 1617,
  gitStatusOpen: 1630,
  gitStatusApplied: 1631,
  gitStatusClosed: 1632,
  gitStatusDraft: 1633,
} as const;

export type KanbanKind = (typeof KANBAN_KINDS)[keyof typeof KANBAN_KINDS];
