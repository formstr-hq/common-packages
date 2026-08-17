import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools";

import { CalendarSDK } from "../src/CalendarSDK";
import { CALENDAR_KINDS } from "../src/kinds";
import { RelaysRequiredError, SignerRequiredError, ViewKeyRequiredError } from "../src/contracts";
import { RSVPStatus, type CalendarEventDraft } from "../src/types";
import { FakeRuntime, makeUser, type TestUser } from "./helpers";

let runtime: FakeRuntime;
let alice: TestUser;
let bob: TestUser;
let sdk: CalendarSDK;

const draft: CalendarEventDraft = {
  title: "Retro",
  description: "What went well",
  begin: 1_800_000_000_000,
  end: 1_800_003_600_000,
};

beforeEach(() => {
  runtime = new FakeRuntime();
  alice = makeUser();
  bob = makeUser();
  sdk = new CalendarSDK({ signer: alice.signer, runtime, relays: ["wss://test.relay"] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("construction", () => {
  it("refuses to run without relays instead of inventing a set", () => {
    expect(() => new CalendarSDK({ runtime, relays: [] })).toThrow(RelaysRequiredError);
  });

  it("normalizes the relays it was given", () => {
    const plain = new CalendarSDK({ runtime, relays: ["wss://Test.Relay/", "wss://test.relay"] });
    expect(plain.relays).toEqual(["wss://test.relay"]);
  });

  it("throws a named error for anything needing a signer", async () => {
    const readOnly = new CalendarSDK({ runtime, relays: ["wss://test.relay"] });
    await expect(readOnly.fetchCalendars()).rejects.toThrow(SignerRequiredError);
  });

  it("closes only the runtime it created", () => {
    const injected = new FakeRuntime();
    new CalendarSDK({
      signer: alice.signer,
      runtime: injected,
      relays: ["wss://test.relay"],
    }).dispose();
    expect(injected.disposed).toBe(false);
  });
});

describe("calendars", () => {
  it("creates, fetches and updates a list", async () => {
    const created = await sdk.createCalendar({ title: "Work", color: "#111111" });
    const fetched = await sdk.fetchCalendars();
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ id: created.id, title: "Work", color: "#111111" });

    const renamed = await sdk.updateCalendar({ ...fetched[0], title: "Deep work" });
    expect((await sdk.fetchCalendars())[0].title).toBe("Deep work");
    expect(renamed.createdAt).toBeGreaterThan(created.createdAt - 1);
  });

  it("supersedes a same-second republish instead of losing the edit", async () => {
    // Both writes land in the same second. Without nextCreatedAt, NIP-01's
    // lowest-id tie-break can keep the STALE version.
    const created = await sdk.createCalendar({ title: "First" });
    const second = await sdk.updateCalendar({ ...created, title: "Second" });
    const third = await sdk.updateCalendar({ ...second, title: "Third" });

    expect(third.createdAt).toBeGreaterThan(second.createdAt);
    expect((await sdk.fetchCalendars())[0].title).toBe("Third");
  });

  it("skips a list it cannot decrypt rather than losing every other calendar", async () => {
    await sdk.createCalendar({ title: "Mine" });
    // Someone else's 32123, or a wrong-kind delivery — both happen in practice.
    runtime.seed(
      finalizeEvent(
        {
          kind: CALENDAR_KINDS.calendarList,
          created_at: 1_800_000_000,
          tags: [["d", "theirs"]],
          content: "not-decryptable-by-alice",
        },
        bob.secretKey,
      ),
    );
    expect(await sdk.fetchCalendars()).toHaveLength(1);
  });

  it("moves an event, publishing the destination before the source", async () => {
    const work = await sdk.createCalendar({ title: "Work" });
    const personal = await sdk.createCalendar({ title: "Personal" });
    const published = await sdk.publishPrivateEvent(draft, {
      calendarId: work.id,
      calendars: [work, personal],
      skipInvitations: true,
    });

    const lists = await sdk.fetchCalendars();
    const { source, target } = await sdk.moveEventBetweenCalendars(
      lists,
      personal.id,
      published.eventRef,
    );

    expect(target.eventRefs.map((r) => r[0])).toContain(published.eventRef[0]);
    expect(source?.eventRefs ?? []).toHaveLength(0);

    const order = runtime
      .publishedOfKind(CALENDAR_KINDS.calendarList)
      .slice(-2)
      .map((e) => e.tags.find((t) => t[0] === "d")?.[1]);
    expect(order).toEqual([personal.id, work.id]);
  });
});

describe("private events", () => {
  it("links the event into a calendar so the view key survives", async () => {
    const calendar = await sdk.createCalendar({ title: "Work" });
    const published = await sdk.publishPrivateEvent(draft, {
      calendarId: calendar.id,
      calendars: [calendar],
      skipInvitations: true,
    });

    const lists = await sdk.fetchCalendars();
    expect(lists[0].eventRefs).toEqual([published.eventRef]);
    expect(await sdk.lookupEventViewKey(published.eventRef[0], lists)).toBe(published.viewKey);
  });

  it("refuses to publish against a calendar that does not exist", async () => {
    // Silently skipping the link would publish an event whose view key is
    // recorded nowhere — unreadable forever.
    await expect(
      sdk.publishPrivateEvent(draft, { calendarId: "nope", calendars: [], skipInvitations: true }),
    ).rejects.toThrow(/not found/);
  });

  it("recovers the view key from the calendar list on edit", async () => {
    const calendar = await sdk.createCalendar({ title: "Work" });
    const published = await sdk.publishPrivateEvent(draft, {
      calendarId: calendar.id,
      calendars: [calendar],
      skipInvitations: true,
    });

    // The caller no longer holds the key — only the list ref does.
    const updated = await sdk.updatePrivateEvent(
      { ...draft, id: published.event.id, title: "Retro (moved)" },
      {
        skipInvitations: true,
        previousCreatedAt: published.event.createdAt,
        previousParticipants: [],
      },
    );

    expect(updated.viewKey).toBe(published.viewKey);
    const reread = await sdk.fetchEventByCoordinate(published.eventRef[0], {
      viewKey: published.viewKey,
    });
    expect(reread?.title).toBe("Retro (moved)");
  });

  it("throws rather than minting a fresh key when none can be recovered", async () => {
    // A rotated key leaves the event unreadable to everyone already invited,
    // while the ref still points at the old one.
    await expect(
      sdk.updatePrivateEvent(
        { ...draft, id: "orphan" },
        { calendars: [], previousParticipants: [] },
      ),
    ).rejects.toThrow(ViewKeyRequiredError);
  });

  it("supersedes the previous version of an event", async () => {
    const calendar = await sdk.createCalendar({ title: "Work" });
    const first = await sdk.publishPrivateEvent(draft, {
      calendarId: calendar.id,
      calendars: [calendar],
      skipInvitations: true,
    });
    const second = await sdk.updatePrivateEvent(
      { ...draft, id: first.event.id, title: "Renamed" },
      {
        viewKey: first.viewKey,
        previousCreatedAt: first.event.createdAt,
        skipInvitations: true,
        previousParticipants: [],
      },
    );

    expect(second.event.createdAt).toBeGreaterThan(first.event.createdAt);
    const current = await sdk.fetchEventByCoordinate(first.eventRef[0], {
      viewKey: first.viewKey,
    });
    expect(current?.title).toBe("Renamed");
  });

  it("reads every event across every calendar", async () => {
    const work = await sdk.createCalendar({ title: "Work" });
    const personal = await sdk.createCalendar({ title: "Personal" });
    await sdk.publishPrivateEvent(draft, {
      calendarId: work.id,
      calendars: [work, personal],
      skipInvitations: true,
    });
    await sdk.publishPrivateEvent(
      { ...draft, title: "Dentist" },
      { calendarId: personal.id, calendars: [work, personal], skipInvitations: true },
    );

    const events = await sdk.fetchEvents();
    expect(events.map((e) => e.title).sort()).toEqual(["Dentist", "Retro"]);
  });
});

describe("invitations", () => {
  it("invites participants but never the author", async () => {
    const published = await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});
    expect(published.invitations).toHaveLength(1);
    expect(published.invitations[0].tags).toContainEqual(["p", bob.pubkey]);

    // Alice's own inbox stays clean.
    expect(await sdk.fetchInvitations()).toHaveLength(0);
  });

  it("only invites participants who are new to this version", async () => {
    const calendar = await sdk.createCalendar({ title: "Work" });
    const carol = makeUser();
    const first = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      { calendarId: calendar.id, calendars: [calendar] },
    );

    const second = await sdk.updatePrivateEvent(
      { ...draft, id: first.event.id, participants: [bob.pubkey, carol.pubkey] },
      { viewKey: first.viewKey, previousParticipants: [bob.pubkey], calendars: [calendar] },
    );

    expect(second.invitations).toHaveLength(1);
    expect(second.invitations[0].tags).toContainEqual(["p", carol.pubkey]);
  });

  it("resends to everyone when the caller asks for it with an empty list", async () => {
    // `previousParticipants: []` is the deliberate resend — the reason the field
    // is required rather than defaulted.
    const calendar = await sdk.createCalendar({ title: "Work" });
    const first = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      { calendarId: calendar.id, calendars: [calendar] },
    );

    const second = await sdk.updatePrivateEvent(
      { ...draft, id: first.event.id, participants: [bob.pubkey] },
      { viewKey: first.viewKey, previousParticipants: [], calendars: [calendar] },
    );

    expect(second.invitations).toHaveLength(1);
    expect(second.invitations[0].tags).toContainEqual(["p", bob.pubkey]);
  });

  it("delivers to the recipient's own relays, not just ours", async () => {
    runtime.seed(
      finalizeEvent(
        {
          kind: CALENDAR_KINDS.relayList,
          created_at: 1_800_000_000,
          tags: [["r", "wss://bob.example"]],
          content: "",
        },
        bob.secretKey,
      ),
    );

    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});
    expect(await bobSdk.fetchInvitations()).toHaveLength(1);
  });

  it("accepting records the ref so the event becomes readable", async () => {
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});

    const [invitation] = await bobSdk.fetchInvitations();
    const bobCalendar = await bobSdk.createCalendar({ title: "Invited" });
    await bobSdk.acceptInvitation(invitation, bobCalendar);

    const events = await bobSdk.fetchEvents();
    expect(events.map((e) => e.title)).toEqual(["Retro"]);
  });

  it("dismissal by the wrap's own key removes it from the inbox", async () => {
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});

    const [invitation] = await bobSdk.fetchInvitations();
    expect(invitation.signingNsec).toBeDefined();
    await bobSdk.dismissInvitation(invitation);

    expect(await bobSdk.fetchInvitations()).toHaveLength(0);
  });

  it("dismissal also publishes the dismisser's own tombstone", async () => {
    // The wrap-signed deletion is the one a compliant relay honours; this one
    // is what survives a relay that ignores NIP-09.
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});

    const [invitation] = await bobSdk.fetchInvitations();
    await bobSdk.dismissInvitation(invitation);

    const deletions = runtime.publishedOfKind(CALENDAR_KINDS.deletion);
    const own = deletions.filter((event) => event.pubkey === bob.pubkey);
    expect(own).toHaveLength(1);
    expect(own[0].tags).toContainEqual(["e", invitation.giftWrapId]);
    expect(own[0].tags).toContainEqual(["a", invitation.coordinate]);
    expect(own[0].tags).toContainEqual(["k", "1059"]);
  });

  it("a dismissed invitation stays dismissed when re-sent under a new wrap", async () => {
    // Matching on wrap id alone would resurrect it — the sender's second
    // invitation is a different event.
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    const first = await sdk.publishPrivateEvent({ ...draft, participants: [bob.pubkey] }, {});

    const [invitation] = await bobSdk.fetchInvitations();
    await bobSdk.dismissInvitation({ ...invitation, signingNsec: undefined });

    await sdk.publishPrivateEvent(
      { ...draft, id: first.event.id, participants: [bob.pubkey] },
      { viewKey: first.viewKey, dTag: first.event.id },
    );
    expect(await bobSdk.fetchInvitations()).toHaveLength(0);
  });

  it("ignores a 1059 wrap belonging to another app", async () => {
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    runtime.seed(
      finalizeEvent(
        {
          kind: CALENDAR_KINDS.giftWrap,
          created_at: 1_800_000_000,
          tags: [["p", bob.pubkey], ["k", "1052"]],
          content: "gibberish-not-a-seal",
        },
        alice.secretKey,
      ),
    );
    expect(await bobSdk.fetchInvitations()).toEqual([]);
  });
});

describe("RSVPs", () => {
  it("keeps only the newest answer per responder", async () => {
    const published = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    const coordinate = published.eventRef[0];

    await sdk.rsvp({
      coordinate,
      viewKey: published.viewKey,
      payload: { status: RSVPStatus.tentative },
    });
    // An RSVP stamps a plain `now` (parity with upstream), so two answers in
    // the same second tie and NIP-01 breaks the tie by lowest id — which can
    // keep the stale one. Move the clock instead of racing it.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 2000);
    await sdk.rsvp({
      coordinate,
      viewKey: published.viewKey,
      payload: { status: RSVPStatus.accepted, comment: "confirmed" },
    });

    const responses = await sdk.fetchRsvps(coordinate, { viewKey: published.viewKey });
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ status: RSVPStatus.accepted, comment: "confirmed" });
  });

  it("needs the view key for a private event", async () => {
    const published = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    await expect(
      sdk.rsvp({ coordinate: published.eventRef[0], payload: { status: RSVPStatus.accepted } }),
    ).rejects.toThrow(ViewKeyRequiredError);
  });

  it("drops an RSVP that answers a different event", async () => {
    // The relay's #a filter is not trusted on its own.
    const published = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    runtime.seed(
      finalizeEvent(
        {
          kind: CALENDAR_KINDS.privateRsvp,
          created_at: 1_800_000_100,
          tags: [["a", `32678:${alice.pubkey}:someone-else`], ["d", "x"]],
          content: "unreadable",
        },
        bob.secretKey,
      ),
    );
    expect(await sdk.fetchRsvps(published.eventRef[0], { viewKey: published.viewKey })).toEqual([]);
  });
});

describe("busy lists", () => {
  const start = Date.UTC(2026, 3, 10, 9, 0, 0);
  const end = start + 3_600_000;

  it("adds, reads back and removes a range", async () => {
    await sdk.addBusyRange({ start, end });
    expect(await sdk.fetchBusyLists(alice.pubkey, ["2026-04"])).toMatchObject([
      { monthKey: "2026-04", ranges: [{ start, end }] },
    ]);

    await sdk.removeBusyRange({ start, end });
    expect((await sdk.fetchBusyLists(alice.pubkey, ["2026-04"]))[0].ranges).toEqual([]);
  });

  it("stores a cross-month range whole in both months", async () => {
    // Storing it whole is what lets removal match by exact pair from either
    // month's list.
    const spanStart = Date.UTC(2026, 3, 30, 23, 0, 0);
    const spanEnd = Date.UTC(2026, 4, 1, 1, 0, 0);
    await sdk.addBusyRange({ start: spanStart, end: spanEnd });

    const lists = await sdk.fetchBusyLists(alice.pubkey, ["2026-04", "2026-05"]);
    expect(lists.map((l) => l.monthKey).sort()).toEqual(["2026-04", "2026-05"]);
    for (const list of lists) {
      expect(list.ranges).toEqual([{ start: spanStart, end: spanEnd }]);
    }
  });

  it("does not add the same range twice", async () => {
    await sdk.addBusyRange({ start, end });
    await sdk.addBusyRange({ start, end });
    expect((await sdk.fetchBusyLists(alice.pubkey, ["2026-04"]))[0].ranges).toHaveLength(1);
  });

  it("ignores an inverted range", async () => {
    expect(await sdk.addBusyRange({ start: end, end: start })).toEqual([]);
  });

  it("survives back-to-back writes in the same second", async () => {
    // A lost tie-break here drops a busy block, which is a double booking.
    const second = { start: end + 1000, end: end + 2000 };
    await sdk.addBusyRange({ start, end });
    await sdk.addBusyRange(second);

    const ranges = (await sdk.fetchBusyLists(alice.pubkey, ["2026-04"]))[0].ranges;
    expect(ranges).toHaveLength(2);
  });
});

describe("public events", () => {
  it("publishes and reads back", async () => {
    await sdk.publishPublicEvent({ ...draft, participants: [bob.pubkey] });
    const events = await sdk.fetchPublicEvents({ authors: [alice.pubkey] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: draft.title,
      description: draft.description,
      isPrivate: false,
    });
  });

  it("needs no view key to read", async () => {
    const { signedEvent } = await sdk.publishPublicEvent(draft);
    expect(sdk.parseEvent(signedEvent).title).toBe(draft.title);
  });
});
