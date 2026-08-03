import type { Event } from "nostr-tools";

import {
  SignerRequiredError,
  type CalendarCtx,
  type CalendarSigner,
  type NostrRuntime,
  type SubscriptionHandle,
} from "./contracts";
import { CALENDAR_KINDS } from "./kinds";
import type {
  BusyList,
  BusyRange,
  CalendarEvent,
  CalendarEventDraft,
  CalendarList,
  EventRef,
  Invitation,
  InvitationWithEvent,
  RSVPPayload,
  RSVPResponse,
} from "./types";
import { DEFAULT_CALENDAR_RELAYS, normalizeRelayList } from "./discovery/relays";
import { SimplePoolRuntime } from "./runtime/pool";
import { invitationInboxFilters } from "./codec/invitation";
import * as busy from "./services/busy";
import * as calendars from "./services/calendars";
import * as events from "./services/events";
import * as invitations from "./services/invitations";
import * as rsvp from "./services/rsvp";

export interface CalendarSDKOptions {
  /**
   * Required for anything that writes or reads private data. Without it the SDK
   * can still read public events, and every other call throws
   * `SignerRequiredError`.
   */
  signer?: CalendarSigner;
  /** Defaults to the relay set calendar.formstr.app uses. */
  relays?: string[];
  /** Defaults to a built-in `SimplePool`. Inject the host's own to share it. */
  runtime?: NostrRuntime;
  /** Base URL for the share links embedded in invitations. */
  appBaseUrl?: string;
  /** Gift-wrap wire kind. Defaults to 1059. */
  wrapKind?: number;
  /** `k` discriminator on those wraps, and the legacy wire kind. Defaults to 1052. */
  wrapType?: number;
  /** Seal/wrap timestamps. `"real"` (default) matches calendar.formstr.app. */
  wrapTimestamps?: "jittered" | "real";
  /** Read pre-NIP-17 wraps alongside current ones. Defaults to true. */
  readLegacyWraps?: boolean;
}

const DEFAULT_APP_BASE_URL = "https://calendar.formstr.app";

/**
 * The calendar protocol as one object.
 *
 * ```ts
 * const sdk = new CalendarSDK({ signer });
 * const calendar = await sdk.createCalendar({ title: "Work" });
 * await sdk.publishPrivateEvent(draft, { calendarId: calendar.id });
 * ```
 *
 * Every method is a thin call into `services/`; the wire format lives in
 * `codec/` and is documented in docs/protocol.md.
 */
export class CalendarSDK {
  private readonly ctx: CalendarCtx;
  private readonly ownsRuntime: boolean;

  constructor(options: CalendarSDKOptions = {}) {
    const runtime = options.runtime ?? new SimplePoolRuntime();
    this.ownsRuntime = !options.runtime;

    this.ctx = {
      getSigner: async () => {
        if (!options.signer) throw new SignerRequiredError("This operation");
        return options.signer;
      },
      runtime,
      relays: normalizeRelayList(
        options.relays && options.relays.length > 0 ? options.relays : [...DEFAULT_CALENDAR_RELAYS],
      ),
      wrapKind: options.wrapKind ?? CALENDAR_KINDS.giftWrap,
      wrapType: options.wrapType ?? CALENDAR_KINDS.invitationWrapType,
      wrapTimestamps: options.wrapTimestamps ?? "real",
      appBaseUrl: options.appBaseUrl ?? DEFAULT_APP_BASE_URL,
      readLegacyWraps: options.readLegacyWraps ?? true,
    };
  }

  get relays(): readonly string[] {
    return this.ctx.relays;
  }

  /**
   * Releases the sockets this SDK opened. A runtime the host injected is left
   * alone — its lifetime belongs to the host.
   */
  dispose(): void {
    if (this.ownsRuntime) this.ctx.runtime.dispose?.();
  }

  // ── Calendars ─────────────────────────────────────────

  createCalendar(input?: Parameters<typeof calendars.createCalendar>[1]): Promise<CalendarList> {
    return calendars.createCalendar(this.ctx, input);
  }

  fetchCalendars(): Promise<CalendarList[]> {
    return calendars.fetchCalendars(this.ctx);
  }

  updateCalendar(list: CalendarList): Promise<CalendarList> {
    return calendars.publishCalendarList(this.ctx, list);
  }

  deleteCalendar(list: CalendarList): Promise<void> {
    return calendars.deleteCalendar(this.ctx, list);
  }

  linkEventToCalendar(list: CalendarList, ref: EventRef): Promise<CalendarList> {
    return calendars.linkEventToCalendar(this.ctx, list, ref);
  }

  unlinkEventFromCalendar(list: CalendarList, coordinate: string): Promise<CalendarList> {
    return calendars.unlinkEventFromCalendar(this.ctx, list, coordinate);
  }

  moveEventBetweenCalendars(
    lists: readonly CalendarList[],
    targetCalendarId: string,
    ref: EventRef,
  ): Promise<{ source?: CalendarList; target: CalendarList }> {
    return calendars.moveEventBetweenCalendars(this.ctx, lists, targetCalendarId, ref);
  }

  /** The view key recorded for an event in the caller's calendar lists. */
  lookupEventViewKey(coordinate: string, lists?: readonly CalendarList[]): Promise<string | undefined> {
    return calendars.lookupEventViewKey(this.ctx, coordinate, lists);
  }

  // ── Events ────────────────────────────────────────────

  publishPrivateEvent(
    draft: CalendarEventDraft,
    options?: events.PublishPrivateEventOptions,
  ): Promise<events.PublishedEvent> {
    return events.publishPrivateEvent(this.ctx, draft, options);
  }

  /** Edits a private event, reusing its existing view key. */
  updatePrivateEvent(
    draft: CalendarEventDraft & { id: string },
    options?: events.PublishPrivateEventOptions,
  ): Promise<events.PublishedEvent> {
    return events.updatePrivateEvent(this.ctx, draft, options);
  }

  publishPublicEvent(
    draft: CalendarEventDraft,
    options?: { previousCreatedAt?: number },
  ): Promise<{ event: CalendarEvent; signedEvent: Event; relayHint: string }> {
    return events.publishPublicEvent(this.ctx, draft, options);
  }

  fetchEventByCoordinate(
    coordinate: string,
    options?: { viewKey?: string; relays?: string[] },
  ): Promise<CalendarEvent | null> {
    return events.fetchEventByCoordinate(this.ctx, coordinate, options);
  }

  fetchEventsFromCalendars(lists: readonly CalendarList[]): Promise<CalendarEvent[]> {
    return events.fetchEventsFromCalendars(this.ctx, lists);
  }

  /** Every event across every calendar the caller owns. */
  async fetchEvents(): Promise<CalendarEvent[]> {
    return events.fetchEventsFromCalendars(this.ctx, await calendars.fetchCalendars(this.ctx));
  }

  fetchPublicEvents(
    options?: { since?: number; until?: number; authors?: string[]; limit?: number },
  ): Promise<CalendarEvent[]> {
    return events.fetchPublicEvents(this.ctx, options);
  }

  parseEvent(event: Event, options?: { viewKey?: string; relayHint?: string }): CalendarEvent {
    return events.parseEvent(event, options);
  }

  deleteEvent(target: {
    coordinate?: string;
    eventId?: string;
    kind: number;
    reason?: string;
  }): Promise<Event> {
    return events.deleteEvent(this.ctx, target);
  }

  // ── Invitations ───────────────────────────────────────

  fetchInvitations(options?: invitations.FetchInvitationsOptions): Promise<Invitation[]> {
    return invitations.fetchInvitations(this.ctx, options);
  }

  /** Invitations with their referenced events fetched and decrypted. */
  async fetchInvitationsWithEvents(
    options?: invitations.FetchInvitationsOptions,
  ): Promise<InvitationWithEvent[]> {
    const pending = await invitations.fetchInvitations(this.ctx, options);
    const resolved: InvitationWithEvent[] = [];
    for (const invitation of pending) {
      const event = await events.fetchEventByCoordinate(this.ctx, invitation.coordinate, {
        viewKey: invitation.viewKey,
        relays: invitation.relayHint ? [invitation.relayHint] : undefined,
      });
      resolved.push({ ...invitation, event });
    }
    return resolved;
  }

  /**
   * Accepts an invitation by recording its ref — and therefore its view key —
   * in one of the caller's calendar lists.
   */
  acceptInvitation(invitation: Invitation, list: CalendarList): Promise<CalendarList> {
    return calendars.linkEventToCalendar(this.ctx, list, [
      invitation.coordinate,
      invitation.relayHint,
      invitation.viewKey,
    ]);
  }

  dismissInvitation(
    invitation: Pick<Invitation, "giftWrapId" | "coordinate" | "signingNsec">,
  ): Promise<void> {
    return invitations.dismissInvitation(this.ctx, invitation);
  }

  /** Live invitation inbox. Returns a handle the caller must unsubscribe. */
  subscribeToInvitations(
    pubkey: string,
    onInvitation: (wrap: Event) => void,
  ): SubscriptionHandle {
    return this.ctx.runtime.subscribe(
      this.ctx.relays,
      invitationInboxFilters({
        pubkeys: [pubkey],
        wrapKind: this.ctx.wrapKind,
        wrapType: this.ctx.wrapType,
        includeLegacy: this.ctx.readLegacyWraps,
      }),
      { onEvent: onInvitation },
    );
  }

  // ── RSVPs ─────────────────────────────────────────────

  rsvp(params: {
    coordinate: string;
    payload: RSVPPayload;
    viewKey?: string;
    relayHint?: string;
  }): Promise<Event> {
    return rsvp.publishRsvp(this.ctx, params);
  }

  fetchRsvps(
    coordinate: string,
    options?: { viewKey?: string; relays?: string[] },
  ): Promise<RSVPResponse[]> {
    return rsvp.fetchRsvps(this.ctx, coordinate, options);
  }

  // ── Busy lists ────────────────────────────────────────

  fetchBusyLists(pubkey: string, monthKeys: string[]): Promise<BusyList[]> {
    return busy.fetchBusyLists(this.ctx, pubkey, monthKeys);
  }

  addBusyRange(range: BusyRange): Promise<BusyList[]> {
    return busy.addBusyRange(this.ctx, range);
  }

  removeBusyRange(range: BusyRange): Promise<BusyList[]> {
    return busy.removeBusyRange(this.ctx, range);
  }
}
