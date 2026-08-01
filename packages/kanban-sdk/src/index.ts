export { KanbanSDK, DEFAULT_RELAYS, type KanbanSDKOptions } from "./KanbanSDK";
export { KANBAN_KINDS, type KanbanKind } from "./kinds";
export * from "./types";
export {
  BoardNotFoundError,
  NotAMaintainerError,
  InvitationVerificationError,
  NotBoardOwnerError,
  SignerRequiredError,
  ViewKeyRequiredError,
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

// Private-path building blocks (Plan 2).
export { LocalSigner } from "./crypto/localSigner";
export { nip44Decrypt, nip44Encrypt, nip44SelfDecrypt, nip44SelfEncrypt } from "./crypto/nip44";
export {
  decryptWithViewKey,
  encryptWithViewKey,
  generateViewKey,
  viewKeyFromNsec,
  type ViewKey,
} from "./crypto/viewKey";
export { BLINDED_POINTER_PREFIX, blindedPointer } from "./crypto/blindedPointer";
export {
  PRIVATE_BOARD_MANAGED_TAGS,
  buildPrivateBoardTags,
  parsePrivateBoard,
} from "./codec/board";
export { PRIVATE_CARD_MANAGED_TAGS, buildPrivateCardTags, parsePrivateCard } from "./codec/card";
export {
  DEFAULT_BOARD_LIST_TITLE,
  boardListDTag,
  buildBoardRef,
  decodeBoardList,
  encodeBoardList,
  parseBoardRef,
} from "./codec/boardList";
export { boardPointer } from "./services/cards";
export { resolveBoardViewKey } from "./services/boards";

// Sharing (Plan 3).
export {
  buildSelfSignedDeletion,
  createRumor,
  createSeal,
  createWrap,
  unwrapEvent,
  wrapEvent,
  wrapManyEvents,
  type WrapOptions,
} from "./crypto/nip59";
export { fetchRelayListsForPubkeys, getInvitationInboxRelays } from "./discovery/relays";
export { buildInvitationRumorTags, parseInvitationRumor } from "./codec/invitation";
export { COMMENT_MANAGED_TAGS, buildCommentTags, parseComment } from "./codec/comment";
export { canComment } from "./services/comments";
export { resolveWithRotation } from "./services/cards";
export type { BoardMember, RotationResult } from "./services/members";
