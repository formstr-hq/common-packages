import type { Event } from "nostr-tools";

/**
 * Domain models. Field names and units deliberately track nostr-calendar's
 * `src/utils/types.ts` — `begin`/`end` are **milliseconds** in memory and
 * seconds on the wire, `createdAt` is **seconds** — so translating between the
 * two codebases stays mechanical.
 */

export type NotificationPreference = "enabled" | "disabled";

export enum RSVPStatus {
  accepted = "accepted",
  declined = "declined",
  tentative = "tentative",
}

/** Friendly recurrence presets, mapped to RRULEs by `codec/recurrence.ts`. */
export enum RepeatingFrequency {
  None = "none",
  Daily = "daily",
  Weekly = "weekly",
  Weekday = "weekdays",
  Monthly = "monthly",
  Quarterly = "quarterly",
  Yearly = "yearly",
}

/**
 * A Formstr form attached to a calendar event, stored as `["form", naddr, viewKey?]`.
 *
 * `viewKey` is the form's **read-only** NIP-44 decryption key. It must never be
 * the form's `responseKey` (admin/edit key) — that would grant every recipient
 * write access to the form definition. docs/protocol.md §10.
 */
export interface FormAttachment {
  naddr: string;
  viewKey?: string;
}

export interface CalendarEvent {
  /** The `d` tag. For private events this comes from the *decrypted* payload. */
  id: string;
  /** Nostr event id (hash) of the version this was parsed from. */
  eventId: string;
  kind: number;
  title: string;
  description: string;
  /** Milliseconds since epoch. */
  begin: number;
  /** Milliseconds since epoch. */
  end: number;
  allDay: boolean;
  image?: string;
  /** Repeats on the wire; always an array here, possibly empty. */
  location: string[];
  /** For a private event: the creator first, then invitees. */
  participants: string[];
  /** From `t` rows. Read-only in practice — no publish path writes them. */
  categories: string[];
  /** From `r` rows. Read-only in practice. */
  references: string[];
  /** From `g` rows. Read-only in practice. */
  geohashes: string[];
  /** Author pubkey. */
  user: string;
  isPrivate: boolean;
  /** nsec-encoded view key, when one was supplied or recovered. */
  viewKey?: string;
  /** Relay the event was fetched from or last published to, when known. */
  relayHint?: string;
  repeat: { rrule: string | null };
  notificationPreference?: NotificationPreference;
  forms?: FormAttachment[];
  /** Nostr `created_at`, in **seconds**. */
  createdAt: number;
  /** The wire event this was parsed from, for hosts that need the raw bytes. */
  event?: Event;
}

/** Input to a publish. Only `title`, `begin` and `end` are required. */
export interface CalendarEventDraft {
  /** Existing `d` tag. Supply on edit; omit to mint one. */
  id?: string;
  title: string;
  description?: string;
  /** Milliseconds since epoch. */
  begin: number;
  /** Milliseconds since epoch. */
  end: number;
  image?: string;
  location?: string[];
  participants?: string[];
  /** Explicit RRULE. Wins over `repeat` when both are set. */
  rrule?: string | null;
  /** Friendly preset, mapped to an RRULE when `rrule` is absent. */
  repeat?: RepeatingFrequency;
  notificationPreference?: NotificationPreference;
  forms?: FormAttachment[];
}

/**
 * A reference to an event inside a calendar list:
 * `["<kind>:<author>:<dTag>", "<relayUrl>", "<viewKeyNsec>"]`.
 */
export type EventRef = [coordinate: string, relayUrl: string, viewKey: string];

export interface CalendarList {
  /** The `d` tag. */
  id: string;
  /** Nostr event id of the version this was parsed from. */
  eventId: string;
  title: string;
  description: string;
  /** Hex colour, e.g. `#4285f4`. */
  color: string;
  /** Absent means enabled — `"enabled"` is never written to the wire. */
  notificationPreference?: NotificationPreference;
  eventRefs: EventRef[];
  /** Nostr `created_at`, in seconds. */
  createdAt: number;
}

/** The decrypted payload of an invitation gift wrap. */
export interface Invitation {
  /** Event id of the gift wrap that delivered this. */
  giftWrapId: string;
  /** Sender — verified against the seal's signer, never the bare rumor claim. */
  senderPubkey: string;
  /** The invited pubkey, from the rumor's `p` row. */
  recipientPubkey: string;
  /** The referenced event's `d` tag. */
  eventId: string;
  /** Kind from the `a` coordinate — `32678` in practice. */
  kind: number;
  /** Author of the referenced event. */
  authorPubkey: string;
  /** Full `a` coordinate, `<kind>:<author>:<dTag>`. */
  coordinate: string;
  /** nsec-encoded view key for the referenced event. */
  viewKey: string;
  relayHint: string;
  /** Human-readable message the sender wrote into the rumor's content. */
  message?: string;
  /**
   * nsec of the wrap's ephemeral signing key, letting the recipient self-sign a
   * NIP-09 deletion of the wrap. Absent on wraps sent before this existed.
   */
  signingNsec?: string;
  /** Rumor `created_at`, in seconds. */
  createdAt: number;
}

/** An invitation with its referenced event resolved and decrypted. */
export interface InvitationWithEvent extends Invitation {
  event: CalendarEvent | null;
}

export interface RSVPPayload {
  status: RSVPStatus;
  /** Unix **seconds**. */
  suggestedStart?: number;
  /** Unix **seconds**. */
  suggestedEnd?: number;
  comment?: string;
}

export interface RSVPResponse {
  /** Responder pubkey. */
  pubkey: string;
  status: RSVPStatus;
  suggestedStart?: number;
  suggestedEnd?: number;
  comment: string;
  /** Nostr `created_at`, in seconds. */
  createdAt: number;
  /** The `<kind>:<author>:<dTag>` the RSVP answers. */
  eventCoord: string;
}

/** A blocked range in a public busy list. Milliseconds since epoch. */
export interface BusyRange {
  start: number;
  end: number;
}

/**
 * One user's public busy list for one calendar month. Addressable per
 * `(user, monthKey)`; republishing replaces only that month.
 */
export interface BusyList {
  /** Owner pubkey. */
  user: string;
  /** `YYYY-MM`. */
  monthKey: string;
  /** Sorted and deduped. */
  ranges: BusyRange[];
  /** Nostr event id, or `""` when not yet published. */
  eventId: string;
  /** Nostr `created_at`, in seconds. */
  createdAt: number;
}
