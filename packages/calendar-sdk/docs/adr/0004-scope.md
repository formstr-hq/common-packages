# ADR 0004 — Scope: the calendar core, not the whole app

**Status:** accepted, 2026-08-03

## Context

nostr-calendar publishes seventeen event kinds. Not all of them are the calendar
protocol; several are application plumbing that happens to travel over Nostr.

The previous version of this package shipped appointment scheduling and booking
alongside the calendar core, and the two were entangled: the booking service
reached into event publishing, and the facade carried eight booking methods.

## Decision

**In scope** — the interoperability surface two calendar clients must agree on:

| Kind | |
|---|---|
| `32678` | private calendar event |
| `31923` | public calendar event |
| `32123` | private calendar list |
| `1059` / `1052` / `14` | invitation gift wrap, legacy wrap, rumor |
| `32069` / `31925` | private and public RSVP |
| `31926` | public busy list |
| `5` / `84` | deletion, legacy participant removal |
| `10002` | NIP-65 relay list |
| `0` | profile, read-only for sender display names |
| `30168` / `1069` | Formstr form attachments |

**Out of scope, deliberately:**

- **Scheduling pages (`31927`) and booking (`1059` with `k=1057`/`k=1058`, plus
  the `32680` key sidecar).** This is a product feature built *on top of* the
  calendar protocol: a booking approval publishes an ordinary private event and
  an ordinary gift wrap. Everything it needs is already here, so it can return
  as one service module without touching the wire format. Its bytes are
  documented in `docs/protocol.md` §1 so that work does not start from scratch.
- **Settings (`30078`), reports (`1984`), NIP-05.** Application concerns. Two
  calendars interoperate fine without agreeing on them.
- **Notifications and device-calendar import.** Local to the app; nothing goes
  on the wire.

## Costs

- The booking feature loses its SDK path until it is re-added. Any host that was
  going to depend on it has to wait or call the primitives directly.
- The line between "protocol" and "application" is a judgement call. Scheduling
  pages are the closest case — they are addressable, encrypted, and shared
  between clients, so a reasonable person could put them on the other side.

## When to revisit

When a second client needs to read or write scheduling pages. At that point the
kinds are already specified and the primitives already exist; it is one service
plus a codec.
