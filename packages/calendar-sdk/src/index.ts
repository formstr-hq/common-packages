// ── The SDK ─────────────────────────────────────────────
export { CalendarSDK, type CalendarSDKOptions } from "./CalendarSDK";

// ── Host integration points ─────────────────────────────
export {
  SignerRequiredError,
  ViewKeyRequiredError,
  GiftWrapVerificationError,
  CalendarNotFoundError,
  type CalendarSigner,
  type NostrRuntime,
  type SubscriptionHandle,
} from "./contracts";
export { toCalendarSigner } from "./adapters/signer";
export { LocalSigner } from "./crypto/localSigner";
export { SimplePoolRuntime } from "./runtime/pool";

// ── Kinds and domain types ──────────────────────────────
export { CALENDAR_KINDS, ADDRESSABLE_KINDS, type CalendarKind } from "./kinds";
export {
  RSVPStatus,
  RepeatingFrequency,
  type BusyList,
  type BusyRange,
  type CalendarEvent,
  type CalendarEventDraft,
  type CalendarList,
  type EventRef,
  type FormAttachment,
  type Invitation,
  type InvitationWithEvent,
  type NotificationPreference,
  type RSVPPayload,
  type RSVPResponse,
} from "./types";

// ── Crypto primitives ───────────────────────────────────
export { selfEncrypt, selfDecrypt } from "./crypto/nip44";
export {
  decodeViewKey,
  decryptWithViewKey,
  encodeViewKey,
  encryptWithViewKey,
  generateViewKey,
  type ViewKey,
} from "./crypto/viewKey";
export {
  buildSelfSignedDeletion,
  createRumor,
  createSeal,
  createWrap,
  unwrapEvent,
  wrapEvent,
  type Rumor,
  type WrapOptions,
} from "./crypto/nip59";

// ── Codecs, for hosts that build or parse events themselves ──
export {
  buildPrivateEventPayload,
  buildPublicEventTags,
  draftRrule,
  isAllDayEvent,
  parseCalendarEvent,
  readRrule,
  type ParseEventOptions,
} from "./codec/event";
export {
  DEFAULT_CALENDAR_COLOR,
  DEFAULT_CALENDAR_TITLE,
  decodeCalendarList,
  encodeCalendarListPayload,
  findCalendarForCoordinate,
  lookupViewKey,
} from "./codec/calendarList";
export {
  INVITATION_RUMOR_KINDS,
  buildInvitationMessage,
  buildInvitationRumorTags,
  buildPrivateEventUrl,
  invitationInboxFilters,
  parseInvitationRumor,
  senderDisplayName,
} from "./codec/invitation";
export {
  buildPrivateRsvpTags,
  buildPublicRsvpTags,
  latestRsvpPerResponder,
  normalizeRsvpPayload,
  parsePrivateRsvp,
  parsePublicRsvp,
  rsvpDTag,
} from "./codec/rsvp";
export {
  busyListMonthKey,
  busyListMonthKeysForRange,
  busyListToTags,
  collectBusyRanges,
  isBusyListMonthKey,
  normalizeBusyRanges,
  parseBusyListEvent,
  rangesEqual,
} from "./codec/busyList";
export {
  formAttachmentToTag,
  formAttachmentsToTags,
  parseFormAttachments,
} from "./codec/formAttachment";
export {
  expandOccurrences,
  frequencyToRrule,
  isEventInDateRange,
  normalizeRule,
  occurrenceStartsInRange,
  rruleToFrequency,
  type Occurrence,
} from "./codec/recurrence";
export {
  buildEventRef,
  coordinate,
  makeDTag,
  nextCreatedAt,
  parseCoordinate,
  parseEventRef,
  previousCreatedAtSeconds,
} from "./codec/identifiers";

// ── Discovery ───────────────────────────────────────────
export {
  DEFAULT_CALENDAR_RELAYS,
  buildRelayListTags,
  fetchRelayLists,
  normalizeRelayList,
  normalizeRelayUrl,
  outboxRelaysFor,
  parseRelayListEvent,
} from "./discovery/relays";
export { dedupeById, newestByCoordinate, newestByDTag, supersedes } from "./discovery/dedupe";
export {
  buildDeletionTags,
  emptyDeletionIndex,
  fetchDeletions,
  indexDeletions,
  isDeleted,
  type DeletionIndex,
} from "./discovery/deletions";
