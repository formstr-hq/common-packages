export { KanbanSDK, DEFAULT_RELAYS, type KanbanSDKOptions } from "./KanbanSDK";
export { KANBAN_KINDS, type KanbanKind } from "./kinds";
export * from "./types";
export {
  BoardNotFoundError,
  NotAMaintainerError,
  SignerRequiredError,
  type KanbanCtx,
  type KanbanSigner,
  type NostrRuntime,
  type SubscriptionHandle,
} from "./contracts";
export { SimplePoolRuntime } from "./runtime/pool";

// Pure building blocks, for hosts and tests working below the facade.
export {
  BOARD_MANAGED_TAGS,
  boardCoordinate,
  buildPublicBoardTags,
  isLegacyBoard,
  mergeTags,
  parsePublicBoard,
} from "./codec/board";
export {
  CARD_MANAGED_TAGS,
  buildCardLinkTag,
  buildPublicCardTags,
  parseCardLink,
  parsePublicCard,
} from "./codec/card";
export { RANK_STEP, computeRank, needsRebalance, rebalance } from "./codec/rank";
export { newestByDTag, nextCreatedAt, supersedes } from "./discovery/dedupe";
export { collectDeleted, isDeleted, type DeletedSet } from "./discovery/deletions";
export { normalizeRelayList, normalizeRelayUrl, parseRelayList } from "./discovery/relays";
export { canEditCards } from "./services/cards";
