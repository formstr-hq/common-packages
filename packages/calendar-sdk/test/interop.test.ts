import { beforeEach, describe, expect, it } from "vitest";
import { finalizeEvent, nip19 } from "nostr-tools";
import type { Event } from "nostr-tools";

import { CalendarSDK } from "../src/CalendarSDK";
import { CALENDAR_KINDS } from "../src/kinds";
import { RSVPStatus, type CalendarEventDraft } from "../src/types";
import { parseCalendarEvent } from "../src/codec/event";
import { decodeCalendarList } from "../src/codec/calendarList";
import { parseBusyListEvent } from "../src/codec/busyList";
import { parsePrivateRsvp, parsePublicRsvp } from "../src/codec/rsvp";
import { parseInvitationRumor } from "../src/codec/invitation";
import { unwrapEvent } from "../src/crypto/nip59";
import { FakeRuntime, makeUser, type TestUser } from "./helpers";
import * as upstream from "./upstream-parsers";

/**
 * Bidirectional interop against calendar.formstr.app's own code.
 *
 * Outbound: everything the SDK publishes is fed to upstream's real parser.
 * Inbound: everything upstream's real writer produces is fed to the SDK's.
 *
 * A test failing here means the two clients disagree on the wire, which is the
 * only failure mode this package exists to prevent.
 */

let runtime: FakeRuntime;
let alice: TestUser;
let bob: TestUser;
let sdk: CalendarSDK;

const draft: CalendarEventDraft = {
  title: "Design review",
  description: "Go through the new flows",
  begin: 1_800_000_000_000,
  end: 1_800_003_600_000,
  location: ["Room 4", "https://meet.example"],
  image: "https://img.example/cover.png",
  rrule: "FREQ=WEEKLY",
  notificationPreference: "enabled",
  forms: [{ naddr: "naddr1form", viewKey: "form-view-key" }],
};

beforeEach(() => {
  runtime = new FakeRuntime();
  alice = makeUser();
  bob = makeUser();
  sdk = new CalendarSDK({
    signer: alice.signer,
    runtime,
    relays: ["wss://test.relay"],
    appBaseUrl: "https://calendar.formstr.app",
  });
});

describe("private event — outbound", () => {
  it("upstream's parser reads every field back off what we publish", async () => {
    const published = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      { skipInvitations: true },
    );

    // Exactly the path calendar.formstr.app takes: decrypt with the view key,
    // which REPLACES the outer tags, then run its parser over the result.
    const decrypted = upstream.viewPrivateEvent(published.signedEvent, published.viewKey);
    expect(decrypted).not.toBeNull();

    const parsed = upstream.nostrEventToCalendar(decrypted!, "cal-1", {
      viewKey: published.viewKey,
      isPrivateEvent: true,
    });

    expect(parsed.id).toBe(published.event.id);
    expect(parsed.title).toBe(draft.title);
    expect(parsed.description).toBe(draft.description);
    expect(parsed.begin).toBe(draft.begin);
    expect(parsed.end).toBe(draft.end);
    expect(parsed.image).toBe(draft.image);
    expect(parsed.location).toEqual(draft.location);
    expect(parsed.repeat.rrule).toBe("FREQ=WEEKLY");
    expect(parsed.notificationPreference).toBe("enabled");
    expect(parsed.forms).toEqual([{ naddr: "naddr1form", viewKey: "form-view-key" }]);
    // Creator first, then invitees.
    expect(parsed.participants).toEqual([alice.pubkey, bob.pubkey]);
  });

  it("does not collapse under an empty id when upstream replaces the tags", async () => {
    // The inner `d` row is the reason this works. Without it upstream's parser
    // sees no `d` at all — every private event lands under id "" and only one
    // survives in the app.
    const a = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    const b = await sdk.publishPrivateEvent(
      { ...draft, title: "Other" },
      { skipInvitations: true },
    );

    const idA = upstream.nostrEventToCalendar(
      upstream.viewPrivateEvent(a.signedEvent, a.viewKey)!,
      "cal",
    ).id;
    const idB = upstream.nostrEventToCalendar(
      upstream.viewPrivateEvent(b.signedEvent, b.viewKey)!,
      "cal",
    ).id;

    expect(idA).not.toBe("");
    expect(idA).not.toBe(idB);
  });

  it("keeps the outer event free of anything that leaks the guest list", async () => {
    const published = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      { skipInvitations: true },
    );
    expect(published.signedEvent.tags).toEqual([["d", published.event.id]]);
  });
});

describe("private event — inbound", () => {
  it("our parser reads an event built by upstream's own writer", async () => {
    const source: upstream.UpstreamCalendarEvent = {
      title: "Upstream event",
      description: "Made by calendar.formstr.app",
      begin: 1_800_000_000_000,
      end: 1_800_007_200_000,
      image: "",
      location: ["Somewhere"],
      participants: [bob.pubkey],
      repeat: { rrule: "FREQ=DAILY" },
      notificationPreference: "disabled",
      forms: [{ naddr: "naddr1x" }],
    };

    const viewSecret = nip19.decode(
      nip19.nsecEncode(new Uint8Array(32).fill(7)),
    ).data as Uint8Array;
    const viewKeyNsec = nip19.nsecEncode(viewSecret);
    const payload = upstream.preparePrivateEventData(source, "up-d-tag", alice.pubkey);

    const wire = finalizeEvent(
      {
        kind: CALENDAR_KINDS.privateEvent,
        created_at: 1_800_000_000,
        tags: [["d", "up-d-tag"]],
        content: upstream.selfEncrypt(viewSecret, payload),
      },
      alice.secretKey,
    );

    const parsed = sdk.parseEvent(wire, { viewKey: viewKeyNsec });
    expect(parsed.id).toBe("up-d-tag");
    expect(parsed.title).toBe("Upstream event");
    expect(parsed.description).toBe("Made by calendar.formstr.app");
    expect(parsed.begin).toBe(source.begin);
    expect(parsed.end).toBe(source.end);
    expect(parsed.repeat.rrule).toBe("FREQ=DAILY");
    expect(parsed.notificationPreference).toBe("disabled");
    expect(parsed.forms).toEqual([{ naddr: "naddr1x" }]);
    expect(parsed.participants).toEqual([alice.pubkey, bob.pubkey]);
    // Upstream always writes the row; an empty value must not become "".
    expect(parsed.image).toBeUndefined();
  });
});

describe("public event", () => {
  it("upstream reads our public event, description included", async () => {
    const { signedEvent } = await sdk.publishPublicEvent({
      ...draft,
      participants: [bob.pubkey],
    });
    const parsed = upstream.nostrEventToCalendar(signedEvent, "cal");

    expect(parsed.title).toBe(draft.title);
    // Description lives in content for a public event, and upstream seeds its
    // model from content before any tag overrides it.
    expect(parsed.description).toBe(draft.description);
    expect(parsed.begin).toBe(draft.begin);
    expect(parsed.location).toEqual(draft.location);
    expect(parsed.participants).toEqual([bob.pubkey]);
  });

  it("produces the same tag rows as upstream's public writer", async () => {
    const { signedEvent } = await sdk.publishPublicEvent({ ...draft, id: "fixed-d" });
    const theirs = upstream.preparePublicEventTags(
      {
        title: draft.title,
        description: draft.description ?? "",
        begin: draft.begin,
        end: draft.end,
        image: draft.image,
        location: draft.location ?? [],
        participants: [],
      },
      "fixed-d",
    );
    expect(signedEvent.tags).toEqual(theirs);
  });

  it("we read an event built by upstream's public writer", () => {
    const tags = upstream.preparePublicEventTags(
      {
        title: "Upstream public",
        description: "desc",
        begin: 1_800_000_000_000,
        end: 1_800_003_600_000,
        image: "https://i",
        location: ["Hall"],
        participants: [bob.pubkey],
      },
      "pub-d",
    );
    const wire = finalizeEvent(
      { kind: CALENDAR_KINDS.publicEvent, created_at: 1_800_000_000, tags, content: "desc" },
      alice.secretKey,
    );

    const parsed = parseCalendarEvent(wire);
    expect(parsed).toMatchObject({
      id: "pub-d",
      title: "Upstream public",
      description: "desc",
      image: "https://i",
      location: ["Hall"],
      participants: [bob.pubkey],
      isPrivate: false,
    });
  });
});

describe("calendar list", () => {
  it("upstream decrypts and reads a list we publish", async () => {
    const calendar = await sdk.createCalendar({ title: "Work", color: "#123456" });
    const published = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    const linked = await sdk.linkEventToCalendar(calendar, published.eventRef);

    const wire = runtime
      .publishedOfKind(CALENDAR_KINDS.calendarList)
      .filter((e) => e.tags.some((t) => t[0] === "d" && t[1] === linked.id))
      .at(-1)!;

    const payload = JSON.parse(
      await alice.signer.nip44Decrypt(wire.pubkey, wire.content),
    ) as unknown;
    const theirs = upstream.decryptCalendarList(wire, payload);

    expect(theirs.title).toBe("Work");
    expect(theirs.color).toBe("#123456");
    expect(theirs.eventRefs).toEqual([published.eventRef]);
    // The ref's third element is what makes the event readable again later.
    expect(theirs.eventRefs[0][2]).toBe(published.viewKey);
  });

  it("we read a list built by upstream's writer", async () => {
    const payload = upstream.calendarListPayload({
      title: "Upstream calendar",
      description: "theirs",
      color: "#abcdef",
      notificationPreference: "disabled",
      eventRefs: [[`32678:${alice.pubkey}:d1`, "wss://r", "nsec1x"]],
    });
    const wire = finalizeEvent(
      {
        kind: CALENDAR_KINDS.calendarList,
        created_at: 1_800_000_000,
        tags: [["d", "up-cal"]],
        content: await alice.signer.nip44Encrypt(alice.pubkey, JSON.stringify(payload)),
      },
      alice.secretKey,
    );

    const decoded = decodeCalendarList(
      wire,
      JSON.parse(await alice.signer.nip44Decrypt(wire.pubkey, wire.content)),
    );
    expect(decoded).toMatchObject({
      id: "up-cal",
      title: "Upstream calendar",
      description: "theirs",
      color: "#abcdef",
      notificationPreference: "disabled",
    });
    expect(decoded.eventRefs).toEqual([[`32678:${alice.pubkey}:d1`, "wss://r", "nsec1x"]]);
  });
});

describe("invitations", () => {
  it("upstream's unwrap-and-read path works on a wrap we send", async () => {
    const published = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      {},
    );
    expect(published.invitations).toHaveLength(1);
    const wrap = published.invitations[0];

    expect(wrap.kind).toBe(1059);
    expect(wrap.tags).toContainEqual(["p", bob.pubkey]);
    expect(wrap.tags).toContainEqual(["k", "1052"]);

    const rumor = await upstream.unwrapEvent(wrap, bob.signer);
    expect(rumor.kind).toBe(14);

    const details = upstream.detailsFromRumor(rumor);
    expect(details.eventId).toBe(published.event.id);
    expect(details.authorPubkey).toBe(alice.pubkey);
    expect(details.kind).toBe(CALENDAR_KINDS.privateEvent);
    expect(details.viewKey).toBe(published.viewKey);
    expect(details.signingNsec).toBeDefined();
    expect(details.message).toContain(draft.title);

    // The view key it carries actually opens the event.
    const decrypted = upstream.viewPrivateEvent(published.signedEvent, details.viewKey);
    expect(upstream.nostrEventToCalendar(decrypted!, "c").title).toBe(draft.title);
  });

  it("the embedded signing key is the wrap's own author, so a recipient can delete it", async () => {
    const published = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      {},
    );
    const wrap = published.invitations[0];
    const details = upstream.detailsFromRumor(await upstream.unwrapEvent(wrap, bob.signer));

    const decoded = nip19.decode(details.signingNsec!);
    const deletionAuthor = finalizeEvent(
      { kind: 5, created_at: 1, tags: [["e", wrap.id]], content: "" },
      decoded.data as Uint8Array,
    ).pubkey;
    expect(deletionAuthor).toBe(wrap.pubkey);
  });

  it("we read an invitation wrapped by upstream's own wrapEvent", async () => {
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    const coordinate = `32678:${alice.pubkey}:their-d`;

    const wrap = await upstream.wrapEvent(
      (signingNsec) => ({
        pubkey: alice.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 14,
        content: "Alice has invited you to an event: Upstream party.",
        tags: [
          ["p", bob.pubkey],
          ["a", coordinate, "wss://their.relay"],
          ["viewKey", "nsec1theirs"],
          ["signing_nsec", signingNsec],
        ],
      }),
      bob.pubkey,
      1059,
      [["k", "1052"]],
      alice.signer,
    );
    await runtime.publish([], wrap);

    const invitations = await bobSdk.fetchInvitations();
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      senderPubkey: alice.pubkey,
      authorPubkey: alice.pubkey,
      eventId: "their-d",
      coordinate,
      viewKey: "nsec1theirs",
      relayHint: "wss://their.relay",
    });
  });

  it("ignores a legacy 1052 wrap: the inbox is 1059-only now", async () => {
    // Pre-NIP-17 wraps are deliberately out of scope — the SDK reads exactly
    // what it writes.
    const bobSdk = new CalendarSDK({ signer: bob.signer, runtime, relays: ["wss://test.relay"] });
    const wrap = await upstream.wrapEvent(
      {
        pubkey: alice.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: 52,
        content: "",
        tags: [
          ["p", bob.pubkey],
          ["a", `32678:${alice.pubkey}:legacy-d`, ""],
          ["viewKey", "nsec1legacy"],
        ],
      },
      bob.pubkey,
      1052,
      [],
      alice.signer,
    );
    await runtime.publish([], wrap);

    expect(await bobSdk.fetchInvitations()).toEqual([]);
  });

  it("rejects a forged wrap that upstream would accept", async () => {
    // Upstream's unwrapEvent does no verification, so this is the one place the
    // SDK is deliberately stricter. The rumor claims Alice; the seal is
    // Mallory's. Accepting it means trusting a view key from an impostor.
    const mallory = makeUser();
    const rumor = {
      id: "",
      pubkey: alice.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      kind: 14,
      content: "trust me",
      tags: [["a", `32678:${alice.pubkey}:x`], ["viewKey", "nsec1x"]],
    };
    const seal = await mallory.signer.signEvent({
      kind: 13,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: await mallory.signer.nip44Encrypt(bob.pubkey, JSON.stringify(rumor)),
    });
    const ephemeral = makeUser();
    const wrap = finalizeEvent(
      {
        kind: 1059,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["p", bob.pubkey], ["k", "1052"]],
        content: await new (await import("../src/crypto/localSigner")).LocalSigner(
          ephemeral.secretKey,
        ).nip44Encrypt(bob.pubkey, JSON.stringify(seal)),
      },
      ephemeral.secretKey,
    );

    await expect(unwrapEvent(wrap, bob.signer)).rejects.toThrow(/does not match the seal signer/);

    // Upstream would have taken it at face value.
    const theirs = await upstream.unwrapEvent(wrap, bob.signer);
    expect(theirs.pubkey).toBe(alice.pubkey);
  });
});

describe("RSVPs", () => {
  it("upstream reads a private RSVP we publish", async () => {
    const published = await sdk.publishPrivateEvent(draft, { skipInvitations: true });
    const coordinate = `${CALENDAR_KINDS.privateEvent}:${alice.pubkey}:${published.event.id}`;

    const rsvpEvent = await sdk.rsvp({
      coordinate,
      viewKey: published.viewKey,
      payload: { status: RSVPStatus.tentative, comment: "maybe", suggestedStart: 1_800_000_500 },
    });

    const theirs = upstream.parsePrivateRSVPEvent(rsvpEvent, published.viewKey);
    expect(theirs).toMatchObject({
      pubkey: alice.pubkey,
      status: "tentative",
      comment: "maybe",
      suggestedStart: 1_800_000_500,
      eventCoord: coordinate,
    });
    // The d-tag must match what upstream would derive, or the two clients
    // create two RSVPs for one responder instead of replacing one.
    expect(rsvpEvent.tags).toContainEqual([
      "d",
      upstream.getRsvpDTag(alice.pubkey, alice.pubkey, published.event.id),
    ]);
  });

  it("upstream reads a public RSVP we publish", async () => {
    const coordinate = `${CALENDAR_KINDS.publicEvent}:${alice.pubkey}:pub-d`;
    const rsvpEvent = await sdk.rsvp({
      coordinate,
      payload: { status: RSVPStatus.accepted, comment: "in" },
    });

    const theirs = upstream.parseRSVPTags(
      rsvpEvent.pubkey,
      rsvpEvent.tags,
      rsvpEvent.content,
      rsvpEvent.created_at,
    );
    expect(theirs).toMatchObject({ status: "accepted", comment: "in", eventCoord: coordinate });
  });

  it("we read RSVPs built with upstream's tag builder", () => {
    const tags = upstream.buildRSVPTags({
      referenceKind: CALENDAR_KINDS.publicEvent,
      authorPubKey: alice.pubkey,
      eventDTag: "d1",
      payload: { status: "declined", suggestedStart: 1_800_000_000 },
    });
    tags.push(["d", upstream.getRsvpDTag(bob.pubkey, alice.pubkey, "d1")]);
    const wire = finalizeEvent(
      { kind: CALENDAR_KINDS.publicRsvp, created_at: 1_800_000_000, tags, content: "sorry" },
      bob.secretKey,
    );

    expect(parsePublicRsvp(wire)).toMatchObject({
      status: RSVPStatus.declined,
      suggestedStart: 1_800_000_000,
      comment: "sorry",
    });
  });

  it("we read a private RSVP encrypted by upstream's selfEncrypt", () => {
    const viewSecret = new Uint8Array(32).fill(9);
    const wire = finalizeEvent(
      {
        kind: CALENDAR_KINDS.privateRsvp,
        created_at: 1_800_000_000,
        tags: [["a", `32678:${alice.pubkey}:d1`], ["d", "r1"]],
        content: upstream.selfEncrypt(viewSecret, { status: "accepted", comment: "yes" }),
      },
      bob.secretKey,
    );

    const payload = upstream.selfDecrypt(viewSecret, wire.content);
    expect(parsePrivateRsvp(wire, payload)).toMatchObject({
      status: RSVPStatus.accepted,
      comment: "yes",
    });
  });
});

describe("busy lists", () => {
  const start = Date.UTC(2026, 3, 10, 9, 0, 0);
  const end = start + 3_600_000;

  it("upstream reads a busy list we publish", async () => {
    await sdk.addBusyRange({ start, end });
    const wire = runtime.publishedOfKind(CALENDAR_KINDS.publicBusyList).at(-1)!;

    const theirs = upstream.nostrEventToBusyList(wire);
    expect(theirs).toMatchObject({
      user: alice.pubkey,
      monthKey: "2026-04",
      ranges: [{ start, end }],
    });
    expect(wire.content).toBe("");
    expect(wire.tags).toContainEqual(["t", "busy"]);
  });

  it("we read a busy list written by upstream's writer", () => {
    const wire = finalizeEvent(
      {
        kind: CALENDAR_KINDS.publicBusyList,
        created_at: 1_800_000_000,
        tags: upstream.busyListToTags({ monthKey: "2026-04", ranges: [{ start, end }] }),
        content: "",
      },
      alice.secretKey,
    );
    expect(parseBusyListEvent(wire)).toMatchObject({
      monthKey: "2026-04",
      ranges: [{ start, end }],
    });
  });

  it("produces byte-identical tags to upstream's writer", () => {
    const list = { monthKey: "2026-04", ranges: [{ start, end }] };
    const ours = finalizeEvent(
      {
        kind: CALENDAR_KINDS.publicBusyList,
        created_at: 1,
        tags: upstream.busyListToTags(list),
        content: "",
      },
      alice.secretKey,
    );
    expect(ours.tags).toEqual(upstream.busyListToTags(list));
  });
});

describe("shared identifiers", () => {
  it("derives the same d-tags as upstream", async () => {
    const { makeDTag } = await import("../src/codec/identifiers");
    expect(makeDTag("anything")).toBe(upstream.makeDTag("anything"));
    expect(makeDTag("anything")).toHaveLength(30);
  });

  it("parses an invitation rumor identically to upstream's reader", async () => {
    const published = await sdk.publishPrivateEvent(
      { ...draft, participants: [bob.pubkey] },
      {},
    );
    const wrap = published.invitations[0];

    const ourRumor = await unwrapEvent(wrap, bob.signer);
    const ours = parseInvitationRumor(ourRumor, wrap.id)!;
    const theirs = upstream.detailsFromRumor(await upstream.unwrapEvent(wrap, bob.signer));

    expect(ours.eventId).toBe(theirs.eventId);
    expect(ours.authorPubkey).toBe(theirs.authorPubkey);
    expect(ours.kind).toBe(theirs.kind);
    expect(ours.viewKey).toBe(theirs.viewKey);
    expect(ours.relayHint).toBe(theirs.relayHint);
    expect(ours.signingNsec).toBe(theirs.signingNsec);
    expect(ours.message).toBe(theirs.message);
  });
});

describe("event references survive a round trip through upstream", () => {
  it("a ref written by us resolves to a readable event", async () => {
    const calendar = await sdk.createCalendar({ title: "Shared" });
    const published = await sdk.publishPrivateEvent(draft, {
      calendarId: calendar.id,
      calendars: [calendar],
    });

    const listWire = runtime.publishedOfKind(CALENDAR_KINDS.calendarList).at(-1)!;
    const theirList = upstream.decryptCalendarList(
      listWire,
      JSON.parse(await alice.signer.nip44Decrypt(listWire.pubkey, listWire.content)),
    );

    const [coordinate, , viewKey] = theirList.eventRefs[0];
    expect(coordinate).toBe(
      `${CALENDAR_KINDS.privateEvent}:${alice.pubkey}:${published.event.id}`,
    );

    const eventWire: Event = runtime
      .publishedOfKind(CALENDAR_KINDS.privateEvent)
      .at(-1)!;
    const decrypted = upstream.viewPrivateEvent(eventWire, viewKey);
    expect(upstream.nostrEventToCalendar(decrypted!, theirList.id).title).toBe(draft.title);
  });
});
