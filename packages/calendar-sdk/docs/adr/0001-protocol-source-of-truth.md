# ADR 0001 — The wire format comes from upstream's source, at a pinned SHA

**Status:** accepted, 2026-08-03

## Context

The first version of this package was extracted from `@formstr/agent`'s calendar
service and `@formstr/core`'s crypto. Both were themselves derived from an older
generation of the calendar app, and the divergence was not visible from either
side: the code was internally consistent, the tests passed, and nothing compared
it against what `calendar.formstr.app` actually publishes.

Reading nostr-calendar `3dc32b1` line by line turned up a different protocol,
not a drifted one:

| | extracted version | nostr-calendar v2.1.0 |
|---|---|---|
| Invitation wrap | kind `1052` | `1059` + `["k","1052"]`; 1052 read-only |
| Invitation rumor | kind `52` | `14` (NIP-17), human-readable content |
| Private RSVP | also `1055`/`55` wraps | `32069` only — no such wraps exist |
| `32679` "private recurring" | in the registry | does not exist |
| Private event outer tags | several | exactly `[["d", …]]` |
| Private event inner | `t`, `start_tzid`, `r` | none of those; `image` always written |
| Public event | `description` tag, rrule, tzid | title/d/start/end/image/location/p only |

A client speaking the left column and a client speaking the right column do not
interoperate at all. Not one of those rows would have been caught by the tests
that shipped with it, because every one of them tested our codecs against our
codecs.

`@formstr/kanban-sdk`'s ADR 0001 had already recorded the first row of that
table as a known defect: *"nostr-calendar made the same move (1059 with
["k","1052"]). calendar-sdk has not caught up and still ships 1052 on the wire."*

## Decision

The wire format is **read from `formstr-hq/nostr-calendar` source at a pinned
SHA**, currently `3dc32b1` (tag `v2.1.0`). Not from its README, not from a
generated protocol summary, not from any downstream copy of the protocol.

Three things follow:

1. [`docs/protocol.md`](../protocol.md) records the format with a citation to
   the upstream file and function for each section. When upstream moves, that
   file is updated first and the codecs second.
2. `test/upstream-parsers.ts` carries upstream's **real** readers and writers,
   ported verbatim. Every domain is asserted in both directions against them.
   The file is an oracle: if upstream's parser rejects our output, our output is
   wrong.
3. Where source and any secondary description disagree, source wins. One such
   conflict already exists and is recorded in ADR 0002.

## Costs

- The oracle file duplicates upstream code and will rot when upstream changes.
  That is the point — it rots loudly, as a failing test, instead of quietly.
- Re-porting on each upstream release is manual work.
- Pinning a SHA means the SDK tracks a release, not `main`. A protocol change
  landing upstream is not picked up until someone re-reads it.

## Alternatives rejected

**Depend on nostr-calendar as a package.** It is an application, not a library;
its protocol layer is wired to a Zustand store, a web worker data layer and
`import.meta.env`. Nothing there is importable from Node.

**Write the spec from the app's docs.** Already tried implicitly, and it is how
this situation arose. The docs describe intent; the app publishes bytes. One
concrete example: the code comment above `publishPrivateCalendarEvent` says
invitations go to "each participant (creator included)", and the line below it
wraps `event.participants` only.
