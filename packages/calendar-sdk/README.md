# @formstr/calendar-sdk

Headless TypeScript SDK for the Formstr calendar protocol on Nostr — private and
public events, calendar lists, gift-wrapped invitations, RSVPs and public busy
lists.

Byte-compatible with [calendar.formstr.app](https://calendar.formstr.app): every
wire shape is read from
[`nostr-calendar`](https://github.com/formstr-hq/nostr-calendar) source at a
pinned SHA, and asserted in both directions against that app's own parsers.

```bash
npm install @formstr/calendar-sdk
```

## Five minutes

```ts
import { CalendarSDK, LocalSigner } from "@formstr/calendar-sdk";

const sdk = new CalendarSDK({ signer: new LocalSigner(secretKey) });

// A calendar list holds your events — and their view keys. Make one first.
const work = await sdk.createCalendar({ title: "Work", color: "#4285f4" });

const { event, eventRef, viewKey, invitations } = await sdk.publishPrivateEvent(
  {
    title: "Design review",
    description: "Go through the new flows",
    begin: Date.now() + 3_600_000,
    end: Date.now() + 7_200_000,
    location: ["https://meet.example"],
    participants: [bobPubkey],
  },
  { calendarId: work.id },
);

// Bob, elsewhere:
const [invitation] = await bobSdk.fetchInvitations();
await bobSdk.acceptInvitation(invitation, bobsCalendar);
const events = await bobSdk.fetchEvents();
```

`dispose()` when you are done, to close the sockets the SDK opened.

## The one thing to understand

**A private event is encrypted with a view key that is generated per event, and
the only durable record of that key is the ref inside your calendar list.**

```
["32678:<author>:<dTag>", "<relayUrl>", "<viewKeyNsec>"]
```

Everything else follows from it:

- Publishing without a `calendarId` gives you an event whose key exists only in
  the value you were handed. Store it, or it is gone.
- Editing must reuse the same key. `updatePrivateEvent` recovers it from the ref
  and **throws** if it cannot, rather than minting a new one — a rotated key
  leaves the event unreadable to everyone already invited.
- An invitation carries that key, which makes it a capability, not a
  notification. That is why wraps are verified before they are trusted.

## Configuration

```ts
new CalendarSDK({
  signer,                       // required for anything private
  relays,                       // defaults to the set calendar.formstr.app uses
  runtime,                      // defaults to a built-in SimplePool
  appBaseUrl,                   // base for share links in invitations
  wrapKind: 1059,               // gift-wrap wire kind
  wrapType: 1052,               // its `k` discriminator, and the legacy kind
  wrapTimestamps: "real",       // or "jittered" for NIP-59's anti-correlation
  readLegacyWraps: true,        // also read pre-NIP-17 wraps
});
```

**Signers.** Anything with `getPublicKey`, `signEvent`, `nip44Encrypt` and
`nip44Decrypt` — the same shape `@formstr/kanban-sdk` and `@formstr/sdk` accept,
so one signer object serves all three. Use `toCalendarSigner()` to adapt a
class-based signer; it binds the methods, which bare references do not.

**Runtimes.** All network I/O goes through `NostrRuntime`. The default opens its
own `SimplePool`. To share the host's connections instead:

```ts
import { dataLayer } from "@formstr/local-relay";
import { LocalRelayRuntime } from "@formstr/calendar-sdk/local-relay";

new CalendarSDK({ signer, runtime: new LocalRelayRuntime(dataLayer) });
```

An injected runtime is never disposed by the SDK — its lifetime is the host's.

## API

**Calendars** — `createCalendar` · `fetchCalendars` · `updateCalendar` ·
`deleteCalendar` · `linkEventToCalendar` · `unlinkEventFromCalendar` ·
`moveEventBetweenCalendars` · `lookupEventViewKey`

**Events** — `publishPrivateEvent` · `updatePrivateEvent` · `publishPublicEvent`
· `fetchEvents` · `fetchEventsFromCalendars` · `fetchEventByCoordinate` ·
`fetchPublicEvents` · `parseEvent` · `deleteEvent`

**Invitations** — `fetchInvitations` · `fetchInvitationsWithEvents` ·
`acceptInvitation` · `dismissInvitation` · `subscribeToInvitations`

**RSVPs** — `rsvp` · `fetchRsvps`

**Busy lists** — `fetchBusyLists` · `addBusyRange` · `removeBusyRange`

The codecs, crypto and discovery helpers are exported too, for hosts that build
or parse events themselves.

## Kinds

| Kind | | Kind | |
|---|---|---|---|
| `32678` | private event | `1059` | gift wrap (`k` = `1052`) |
| `31923` | public event | `1052` | legacy wrap, read-only |
| `32123` | private calendar list | `14` | invitation rumor (NIP-17) |
| `32069` | private RSVP | `5` | deletion |
| `31925` | public RSVP | `84` | legacy removal, read-only |
| `31926` | public busy list | `10002` | relay list (NIP-65) |

Scheduling pages and booking are out of scope — see
[ADR 0004](docs/adr/0004-scope.md).

## Interop

`test/upstream-parsers.ts` holds calendar.formstr.app's real readers and writers,
ported verbatim. Every domain is asserted both ways: what we publish goes through
their parser, what their writer produces goes through ours. Unit tests over our
own codecs would prove nothing — they are self-consistent by construction.

Some upstream behaviour looks like a bug and is kept anyway, because fixing it on
one side alone is what would actually break interop. The list is
[ADR 0002](docs/adr/0002-deliberate-parity.md). Where the SDK *is* stricter, every
such change is read-side only and cannot alter a byte either client writes —
[ADR 0003](docs/adr/0003-read-side-hardening.md).

## Documentation

- [`docs/protocol.md`](docs/protocol.md) — the wire format, section by section,
  with a citation to the upstream function behind each one
- [`docs/adr/`](docs/adr/) — decisions that are expensive to rediscover

## Development

```bash
pnpm vitest run    # full suite
pnpm typecheck     # tsc --noEmit, strict
pnpm build         # tsup → ESM + CJS + d.ts
```

Run these from `packages/calendar-sdk/`; from the repo root pnpm cannot find
`vitest`.

MIT.
