/**
 * calendar.formstr.app's OWN readers and writers, ported verbatim.
 *
 * Source: github.com/formstr-hq/nostr-calendar @ 3dc32b1 (tag v2.1.0)
 *   - `nostrEventToCalendar`, `nostrEventToBusyList`, `busyListToTags`
 *       → src/utils/parser.ts
 *   - `preparePrivateCalendarEvent` payload rows, `publishPublicCalendarEvent`
 *     tag rows, `getDetailsFromGiftWrap`
 *       → src/nostr/events.ts
 *   - `encryptCalendarList`, `decryptCalendarList`
 *       → src/nostr/calendars.ts
 *   - `buildRSVPTags`, `getRsvpDTag`, `parsePrivateRSVPEvent`, `parseRSVPTags`
 *       → src/nostr/rsvp.ts
 *   - `makeDTag`, `selfEncrypt`, `selfDecrypt`, `wrapEvent`, `unwrapEvent`
 *       → src/nostr/core.ts, src/nostr/crypto.ts
 *   - `isAllDayEvent` → src/utils/dateHelper.ts
 *
 * THIS FILE IS AN ORACLE, NOT SDK CODE. Never edit it to make a test pass — if
 * upstream's parser rejects our output, our output is wrong. The only changes
 * from the originals are mechanical: upstream's ambient `signerManager` and
 * `dataLayer` singletons become explicit parameters, and dayjs is replaced with
 * plain `Date` arithmetic in `isAllDayEvent`.
 *
 * When upstream moves, re-port from the new SHA and update the header.
 */
import {
  EventTemplate,
  UnsignedEvent,
  NostrEvent,
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  nip19,
} from "nostr-tools";
import type { Event } from "nostr-tools";
import { getConversationKey, encrypt, decrypt } from "nostr-tools/nip44";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type { CalendarSigner } from "../src/contracts";

export const UPSTREAM_SHA = "3dc32b1";

type Rumor = UnsignedEvent & { id: string };

const now = () => Math.round(Date.now() / 1000);

// ── src/nostr/core.ts ─────────────────────────────────────

export function makeDTag(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input))).substring(0, 30);
}

// ── src/nostr/crypto.ts ───────────────────────────────────

export function getTagValue(tags: string[][], name: string): string {
  return tags.find((t) => t[0] === name)?.[1] ?? "";
}

export function selfEncrypt(secretKey: Uint8Array, data: unknown): string {
  const publicKey = getPublicKey(secretKey);
  return encrypt(JSON.stringify(data), getConversationKey(secretKey, publicKey));
}

export function selfDecrypt<T>(secretKey: Uint8Array, content: string): T {
  const publicKey = getPublicKey(secretKey);
  const plaintext = decrypt(content, getConversationKey(secretKey, publicKey));
  return JSON.parse(plaintext) as T;
}

async function createRumor(
  event: Partial<UnsignedEvent>,
  signer: CalendarSigner,
): Promise<Rumor> {
  const rumor: Rumor = {
    created_at: now(),
    content: "",
    kind: 52,
    tags: [],
    ...event,
    id: "",
    pubkey: await signer.getPublicKey(),
  };
  rumor.id = getEventHash(rumor);
  return rumor;
}

async function createSeal(
  rumor: Rumor,
  recipientPublicKey: string,
  signer: CalendarSigner,
): Promise<NostrEvent> {
  const content = await signer.nip44Encrypt(recipientPublicKey, JSON.stringify(rumor));
  return signer.signEvent({
    kind: 13,
    content,
    created_at: now(),
    tags: [],
  } as unknown as EventTemplate);
}

function createWrap(
  seal: NostrEvent,
  recipientPublicKey: string,
  kind: number,
  extraTags: string[][],
  randomKey: Uint8Array,
): NostrEvent {
  const template: EventTemplate = {
    kind,
    content: encrypt(
      JSON.stringify(seal),
      getConversationKey(randomKey, recipientPublicKey),
    ),
    created_at: now(),
    tags: [["p", recipientPublicKey], ...extraTags],
  };
  return finalizeEvent(template, randomKey);
}

export async function wrapEvent(
  event: Partial<UnsignedEvent> | ((signingNsec: string) => Partial<UnsignedEvent>),
  recipientPublicKey: string,
  kind: number,
  extraTags: string[][] = [],
  signer: CalendarSigner,
): Promise<NostrEvent> {
  const randomKey = generateSecretKey();
  const resolvedEvent =
    typeof event === "function" ? event(nip19.nsecEncode(randomKey)) : event;
  const rumor = await createRumor(resolvedEvent, signer);
  const seal = await createSeal(rumor, recipientPublicKey, signer);
  return createWrap(seal, recipientPublicKey, kind, extraTags, randomKey);
}

/**
 * Note what upstream does NOT do here: no seal-signature check and no
 * rumor-author check. The SDK adds both (docs/protocol.md §6.3); this stays
 * faithful so the oracle shows what the app actually accepts.
 */
export async function unwrapEvent(wrap: NostrEvent, signer: CalendarSigner): Promise<Rumor> {
  const seal = JSON.parse(await signer.nip44Decrypt(wrap.pubkey, wrap.content)) as NostrEvent;
  return JSON.parse(await signer.nip44Decrypt(seal.pubkey, seal.content)) as Rumor;
}

// ── src/nostr/events.ts ───────────────────────────────────

export interface UpstreamCalendarEvent {
  title: string;
  description: string;
  begin: number;
  end: number;
  image?: string;
  location: string[];
  participants: string[];
  repeat?: { rrule: string | null };
  notificationPreference?: "enabled" | "disabled";
  forms?: { naddr: string; viewKey?: string }[];
}

/** `preparePrivateCalendarEvent`'s `eventData` rows, verbatim. */
export function preparePrivateEventData(
  event: UpstreamCalendarEvent,
  dTag: string,
  userPublicKey: string,
): (string | number)[][] {
  const eventData: (string | number)[][] = [
    ["title", event.title],
    ["description", event.description],
    ["start", event.begin / 1000],
    ["end", event.end / 1000],
    ["image", event.image ?? ""],
    ["d", dTag],
  ];
  if (event.repeat?.rrule) {
    eventData.push(["L", "rrule"]);
    eventData.push(["l", event.repeat.rrule]);
  }
  if (event.notificationPreference) {
    eventData.push(["notification", event.notificationPreference]);
  }

  event.forms?.forEach((form) => {
    if (!form?.naddr) return;
    if (form.viewKey) {
      eventData.push(["form", form.naddr, form.viewKey]);
    } else {
      eventData.push(["form", form.naddr]);
    }
  });

  event.location.forEach((loc) => {
    eventData.push(["location", loc]);
  });

  eventData.push(["p", userPublicKey]);
  event.participants.forEach((participant) => {
    eventData.push(["p", participant]);
  });

  return eventData;
}

/** `publishPublicCalendarEvent`'s tag rows, verbatim. */
export function preparePublicEventTags(
  event: UpstreamCalendarEvent,
  id: string,
): string[][] {
  const tags = [
    ["title", event.title],
    ["d", id],
    ["start", String(Math.floor(event.begin / 1000))],
    ["end", String(Math.floor(event.end / 1000))],
  ];
  if (event.image) {
    tags.push(["image", event.image]);
  }
  if (event.location.length > 0) {
    event.location.map((location) => {
      tags.push(["location", location]);
    });
  }
  if (event.participants.length > 0) {
    event.participants.forEach((participant) => {
      tags.push(["p", participant]);
    });
  }
  return tags;
}

/** `getDetailsFromGiftWrap`, minus the unwrap step the caller performs. */
export function detailsFromRumor(rumor: Rumor) {
  const aTag = rumor.tags.find((tag) => tag[0] === "a");
  if (!aTag) {
    throw new Error("invalid rumor. a tag not found");
  }
  const eventId = aTag[1].split(":")[2];
  const authorPubkey = aTag[1].split(":")[1];
  const kind = Number(aTag[1].split(":")[0]);
  const relayHint = aTag[2] || "";
  const viewKey = getTagValue(rumor.tags, "viewKey");
  if (!viewKey) {
    throw new Error("invalid rumor: viewKey not found");
  }
  const signingNsec = getTagValue(rumor.tags, "signing_nsec") || undefined;
  return {
    eventId,
    viewKey,
    authorPubkey,
    kind,
    relayHint,
    createdAt: rumor.created_at,
    message: rumor.content || undefined,
    signingNsec,
  };
}

/** `viewPrivateEvent` — note it REPLACES the event's tags. */
export function viewPrivateEvent(calendarEvent: Event, viewKey: string): Event | null {
  const viewPrivateKey = nip19.decode(viewKey as `nsec1${string}`).data as Uint8Array;
  try {
    const decryptedTags = selfDecrypt<string[][]>(viewPrivateKey, calendarEvent.content);
    return { ...calendarEvent, tags: decryptedTags };
  } catch {
    return null;
  }
}

// ── src/utils/dateHelper.ts ───────────────────────────────

export function isAllDayEvent(begin: number, end: number): boolean {
  if (!(end > begin)) return false;
  const start = new Date(begin);
  const finish = new Date(end);
  if (start.getHours() !== 0 || start.getMinutes() !== 0) return false;
  if (finish.getHours() !== 0 || finish.getMinutes() !== 0) return false;
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const durationDays = Math.round((startOfDay(end) - startOfDay(begin)) / 86_400_000);
  return durationDays >= 1;
}

// ── src/utils/parser.ts ───────────────────────────────────

export interface UpstreamParsedEvent {
  description: string;
  user: string;
  begin: number;
  end: number;
  eventId: string;
  kind: number;
  id: string;
  title: string;
  createdAt: number;
  categories: string[];
  reference: string[];
  website: string;
  location: string[];
  geoHash: string[];
  participants: string[];
  viewKey?: string;
  isPrivateEvent: boolean;
  relayHint?: string;
  calendarId: string;
  repeat: { rrule: string | null };
  image?: string;
  notificationPreference?: "enabled" | "disabled";
  forms?: { naddr: string; viewKey?: string }[];
  allDay?: boolean;
  rsvpResponses: unknown[];
}

export const nostrEventToCalendar = (
  event: Event,
  calendarId: string,
  {
    viewKey,
    isPrivateEvent,
    relayHint,
  }: { viewKey?: string; isPrivateEvent?: boolean; relayHint?: string } = {},
): UpstreamParsedEvent => {
  const parsedEvent: UpstreamParsedEvent = {
    description: event.content,
    user: event.pubkey,
    begin: 0,
    end: 0,
    eventId: event.id,
    kind: event.kind,
    id: "",
    title: "",
    createdAt: event.created_at,
    categories: [],
    reference: [],
    website: "",
    location: [],
    geoHash: [],
    participants: [],
    viewKey: viewKey,
    isPrivateEvent: !!isPrivateEvent,
    relayHint: relayHint,
    calendarId: calendarId,
    repeat: { rrule: null },
    rsvpResponses: [],
  };
  event.tags.forEach(([key, value], index) => {
    switch (key) {
      case "description":
        parsedEvent.description = value;
        break;
      case "start":
        parsedEvent.begin = Number(value) * 1000;
        break;
      case "end":
        parsedEvent.end = Number(value) * 1000;
        break;
      case "d":
        parsedEvent.id = value;
        break;
      case "title":
      case "name":
        parsedEvent.title = value;
        break;
      case "r":
        parsedEvent.reference.push(value);
        break;
      case "image":
        parsedEvent.image = value;
        break;
      case "t":
        parsedEvent.categories.push(value);
        break;
      case "location":
        parsedEvent.location.push(value);
        break;
      case "p":
        parsedEvent.participants.push(value);
        break;
      case "g":
        parsedEvent.geoHash.push(value);
        break;
      case "notification":
        if (value === "enabled" || value === "disabled") {
          parsedEvent.notificationPreference = value;
        }
        break;
      case "form":
        if (value) {
          const formViewKey = event.tags[index]?.[2];
          if (!parsedEvent.forms) parsedEvent.forms = [];
          parsedEvent.forms.push({
            naddr: value,
            ...(formViewKey ? { viewKey: formViewKey } : {}),
          });
        }
        break;
      case "L":
        switch (value) {
          case "rrule":
            parsedEvent.repeat = { rrule: event.tags[index + 1]?.[1] || null };
            break;
        }
        break;
    }
  });
  parsedEvent.allDay = isAllDayEvent(parsedEvent.begin, parsedEvent.end);
  return parsedEvent;
};

export interface UpstreamBusyList {
  user: string;
  monthKey: string;
  ranges: { start: number; end: number }[];
  eventId: string;
  createdAt: number;
}

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

export function busyListDTag(monthKey: string): string {
  return monthKey;
}

export function busyListMonthKeyFromDTag(dTag: string): string | null {
  return MONTH_KEY_RE.test(dTag) ? dTag : null;
}

export function nostrEventToBusyList(event: Event): UpstreamBusyList | null {
  const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const monthKey = busyListMonthKeyFromDTag(dTag);
  if (!monthKey) return null;

  const ranges: { start: number; end: number }[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "block") continue;
    const start = Number(tag[1]) * 1000;
    const end = Number(tag[2]) * 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end <= start) continue;
    ranges.push({ start, end });
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const deduped: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const last = deduped[deduped.length - 1];
    if (last && last.start === r.start && last.end === r.end) continue;
    deduped.push(r);
  }

  return {
    user: event.pubkey,
    monthKey,
    ranges: deduped,
    eventId: event.id,
    createdAt: event.created_at,
  };
}

export function busyListToTags(list: {
  monthKey: string;
  ranges: { start: number; end: number }[];
}): string[][] {
  const tags: string[][] = [
    ["d", busyListDTag(list.monthKey)],
    ["t", list.monthKey],
    ["t", "busy"],
  ];
  for (const r of list.ranges) {
    tags.push([
      "block",
      String(Math.floor(r.start / 1000)),
      String(Math.floor(r.end / 1000)),
    ]);
  }
  return tags;
}

// ── src/nostr/calendars.ts ────────────────────────────────

export interface UpstreamCalendarList {
  id: string;
  eventId: string;
  title: string;
  description: string;
  color: string;
  notificationPreference?: "enabled" | "disabled";
  eventRefs: string[][];
  createdAt: number;
  isVisible: boolean;
}

const DEFAULT_CALENDAR_COLOR = "#4285f4";
const DEFAULT_CALENDAR_TITLE = "My Calendar";

/** `encryptCalendarList`'s inner rows, before encryption. */
export function calendarListPayload(list: {
  title: string;
  description: string;
  color: string;
  notificationPreference?: "enabled" | "disabled";
  eventRefs: string[][];
}): string[][] {
  const tags: string[][] = [
    ["title", list.title],
    ["content", list.description],
    ["color", list.color],
  ];
  if (list.notificationPreference === "disabled") {
    tags.push(["notifications", "disabled"]);
  }
  for (const ref of list.eventRefs) {
    tags.push(["a", ...ref]);
  }
  return tags;
}

/** `decryptCalendarList`, with the signer decrypt already applied. */
export function decryptCalendarList(event: Event, decryptedContent: unknown): UpstreamCalendarList {
  if (!Array.isArray(decryptedContent)) {
    throw new Error(
      `Calendar list payload is not a tags array (got ${typeof decryptedContent})`,
    );
  }
  const tags = decryptedContent as string[][];

  let title = DEFAULT_CALENDAR_TITLE;
  let description = "";
  let color = DEFAULT_CALENDAR_COLOR;
  let notificationPreference: "enabled" | "disabled" | undefined;
  const eventRefs: string[][] = [];

  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length === 0) continue;
    switch (tag[0]) {
      case "title":
        title = tag[1];
        break;
      case "content":
        description = tag[1] || "";
        break;
      case "color":
        color = tag[1] || DEFAULT_CALENDAR_COLOR;
        break;
      case "notifications":
        notificationPreference = tag[1] === "disabled" ? "disabled" : "enabled";
        break;
      case "a":
        eventRefs.push([tag[1], tag[2], tag[3]]);
        break;
    }
  }

  const dTag = event.tags.find((t) => t[0] === "d")?.[1] || "";

  return {
    id: dTag,
    eventId: event.id,
    title,
    description,
    color,
    notificationPreference,
    eventRefs,
    createdAt: event.created_at,
    isVisible: true,
  };
}

// ── src/nostr/rsvp.ts ─────────────────────────────────────

export interface UpstreamRsvpRecord {
  pubkey: string;
  status: string;
  suggestedStart?: number;
  suggestedEnd?: number;
  comment: string;
  createdAt: number;
  eventCoord: string;
}

export function getRsvpDTag(
  responderPubkey: string,
  authorPubKey: string,
  eventId: string,
): string {
  return makeDTag(`${responderPubkey}:${authorPubKey}:${eventId}`);
}

export function buildRSVPTags(opts: {
  referenceKind: number;
  authorPubKey: string;
  eventDTag: string;
  relayHint?: string;
  payload: { status: string; suggestedStart?: number; suggestedEnd?: number };
}): string[][] {
  const aValue = `${opts.referenceKind}:${opts.authorPubKey}:${opts.eventDTag}`;
  const tags: string[][] = [
    opts.relayHint ? ["a", aValue, opts.relayHint] : ["a", aValue],
    ["status", opts.payload.status],
  ];
  if (opts.payload.suggestedStart) {
    tags.push(["start", String(opts.payload.suggestedStart)]);
  }
  if (opts.payload.suggestedEnd) {
    tags.push(["end", String(opts.payload.suggestedEnd)]);
  }
  return tags;
}

function normalizeRsvpPayload(
  payload:
    | { status?: string; suggestedStart?: number; suggestedEnd?: number; comment?: string }
    | null
    | undefined,
) {
  if (!payload) return null;
  if (
    payload.status !== "accepted" &&
    payload.status !== "declined" &&
    payload.status !== "tentative"
  ) {
    return null;
  }

  const suggestedStart =
    payload.suggestedStart !== undefined ? Number(payload.suggestedStart) : undefined;
  const suggestedEnd =
    payload.suggestedEnd !== undefined ? Number(payload.suggestedEnd) : undefined;

  return {
    status: payload.status,
    suggestedStart: Number.isFinite(suggestedStart) ? suggestedStart : undefined,
    suggestedEnd: Number.isFinite(suggestedEnd) ? suggestedEnd : undefined,
    comment: payload.comment ?? "",
  };
}

export function parsePrivateRSVPEvent(
  event: Event,
  viewKey: string,
): UpstreamRsvpRecord | null {
  const aTag = event.tags.find((tag) => tag[0] === "a")?.[1];
  if (!aTag) return null;

  const viewPrivateKey = nip19.decode(viewKey as `nsec1${string}`).data as Uint8Array;
  const payload = normalizeRsvpPayload(selfDecrypt(viewPrivateKey, event.content));
  if (!payload) return null;

  return {
    pubkey: event.pubkey,
    status: payload.status,
    suggestedStart: payload.suggestedStart,
    suggestedEnd: payload.suggestedEnd,
    comment: payload.comment,
    createdAt: event.created_at,
    eventCoord: aTag,
  };
}

export const parseRSVPTags = (
  pubkey: string,
  tags: string[][],
  content: string,
  createdAt: number,
): UpstreamRsvpRecord | null => {
  const aTag = tags.find((t) => t[0] === "a")?.[1];
  if (!aTag) return null;
  const payload = normalizeRsvpPayload({
    status: tags.find((t) => t[0] === "status")?.[1],
    suggestedStart: tags.find((t) => t[0] === "start")?.[1]
      ? Number(tags.find((t) => t[0] === "start")?.[1])
      : undefined,
    suggestedEnd: tags.find((t) => t[0] === "end")?.[1]
      ? Number(tags.find((t) => t[0] === "end")?.[1])
      : undefined,
    comment: content || "",
  });
  if (!payload) return null;

  return {
    pubkey,
    status: payload.status,
    suggestedStart: payload.suggestedStart,
    suggestedEnd: payload.suggestedEnd,
    comment: payload.comment,
    createdAt,
    eventCoord: aTag,
  };
};
