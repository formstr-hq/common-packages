# ADR 0001 — Invitations ride kind 1059, typed by a `k` tag

**Status:** accepted, 2026-08-01 · **Supersedes:** wrap kind 1053

## Context

Invitation gift wraps went out as kind **1053**, a private kind inherited from
the calendar SDK. NIP-59 asks relays to serve a wrap only to its `p`-tagged
recipient — but that rule is written for kind **1059** by number. A private kind
gets none of it, so anyone could subscribe to `{"kinds":[1053]}` and enumerate
which pubkeys were being invited to private boards, and how often.

The obvious fix, publishing as 1059, has an obvious cost: every app's wraps then
share one kind, so the inbox query returns DMs and calendar invites too. Each is
a signer round trip to decrypt before you learn it wasn't yours — cheap with a
local key, a network round trip with a NIP-46 bunker.

## Decision

Publish as **1059**, carrying **`["k", "1053"]`**.

`k` is a single-letter tag, so relays can filter on it: the inbox query is
`{"kinds":[1059], "#p":[me], "#k":["1053"]}` — protected *and* narrow. 1053
survives as the type discriminator rather than the wire kind.

Reads accept both shapes. Wraps sent before this change use the old wire kind and
have no `k` tag; dropping that query would strand every invitation in flight.

Both values are configurable (`wrapKind`, `wrapType`) so a host can move again
without an SDK change.

## Costs

- The `k` tag is plaintext: an observer learns a given 1059 is a kanban
  invitation, though not for which board or from whom.
- Relay-side protection is only as good as the relay. Nothing here is enforced.
- Two inbox queries instead of one until legacy support is dropped.

## Prior art

nostr-calendar made the same move (`CalendarEventGiftWrap = 1059` with
`["k","1052"]`). `calendar-sdk` has not caught up and still ships 1052 on the
wire.
