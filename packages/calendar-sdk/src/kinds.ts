/**
 * Calendar event-kind registry, mirroring `EventKinds` in nostr-calendar
 * (`src/nostr/kinds.ts` @ 3dc32b1). Keep every number here so a renumber is a
 * one-file change — see docs/protocol.md §1.
 */
export const CALENDAR_KINDS = {
  // ── Calendar objects ────────────────────────────────────
  /** Private calendar event, view-key encrypted. Outer tags are only `["d",…]`. */
  privateEvent: 32678,
  /** Public calendar event. NIP-52's kind with a simplified tag set. */
  publicEvent: 31923,
  /** Private calendar list, self-encrypted to the owner's own pubkey. */
  calendarList: 32123,
  privateRsvp: 32069,
  publicRsvp: 31925,
  /** Public free/busy list, one addressable event per (user, `YYYY-MM`). */
  publicBusyList: 31926,

  // ── Invitations (NIP-59 / NIP-17) ───────────────────────
  /**
   * Wire kind for every gift wrap this protocol writes. 1059 is the registered
   * NIP-59 kind and the ONLY one relays apply "serve this only to the p-tagged
   * recipient" to — a private wrap kind gets none of that protection.
   */
  giftWrap: 1059,
  /**
   * Value of the `["k", …]` discriminator carried on those wraps, and the
   * pre-NIP-17 wire kind, still read so invitations sent by older builds keep
   * arriving. `k` is single-letter, so the inbox query stays narrow despite
   * every app sharing kind 1059.
   */
  invitationWrapType: 1052,
  /**
   * NIP-17's chat-message kind, reused as the invitation rumor kind so an
   * invite renders as a real DM in any NIP-17 client.
   */
  rumor: 14,
  /** @deprecated pre-NIP-17 invitation rumor kind. Read-only, never written. */
  legacyInvitationRumor: 52,
  /** Legacy participant-removal tombstone. Read-only, never written. */
  participantRemoval: 84,

  // ── Borrowed from other NIPs ────────────────────────────
  deletion: 5,
  seal: 13,
  userProfile: 0,
  relayList: 10002,

  // ── Formstr (NIP-101) form attachments ──────────────────
  formTemplate: 30168,
  formResponse: 1069,
} as const;

export type CalendarKind = (typeof CALENDAR_KINDS)[keyof typeof CALENDAR_KINDS];

/** Addressable (parameterized-replaceable) kinds this SDK writes. */
export const ADDRESSABLE_KINDS: readonly number[] = [
  CALENDAR_KINDS.privateEvent,
  CALENDAR_KINDS.publicEvent,
  CALENDAR_KINDS.calendarList,
  CALENDAR_KINDS.privateRsvp,
  CALENDAR_KINDS.publicRsvp,
  CALENDAR_KINDS.publicBusyList,
];
