# ADR 0003 — Where the SDK is stricter than upstream

**Status:** accepted, 2026-08-03

## Context

ADR 0002 says parity is the default. This records the exceptions, and the test
each one has to pass to qualify: **it must not change a single byte either
client writes.** A read-side check or a timestamp nudge cannot desync two
clients; a different tag row can.

## Decision

**1. Gift wraps are verified before they are trusted.**
Upstream's `unwrapEvent` decrypts both layers and returns the rumor. The rumor is
*unsigned*, so its `pubkey` is an unverified claim. This SDK also requires the
seal to be kind 13, its signature to verify, and `rumor.pubkey === seal.pubkey`,
and throws `GiftWrapVerificationError` otherwise.

This matters more here than in most protocols: an invitation is a **capability**,
not a notification. It carries the event's view key. Without the check a wrap can
be forged to appear to come from a trusted colleague, and the recipient accepts a
key — and an event — from an impostor. The interop suite includes a forged wrap
that upstream accepts and we reject.

**2. Every addressable republish supersedes strictly.**
`created_at = max(now, previous + 1)`. NIP-01 breaks a `created_at` tie by
*lowest event id*, so a write made in the same second as the version it replaces
can silently lose. Upstream does this for events, calendar lists and settings but
not for busy lists; we do it there too, because a lost busy block is a double
booking. The bytes are identical either way.

**3. NIP-09 deletions carry a `k` row.**
Upstream's `buildSelfSignedDeletion` writes `e` rows only. NIP-09 says a deletion
MUST carry `k`. Upstream never *reads* deletion events, so adding it cannot
affect it — while a relay that enforces the rule would otherwise reject the
request and leave invitation dismissal silently broken.

**4. Dismissal is checked client-side against the wrap's own author.**
A self-signed dismissal is authored by the wrap's ephemeral key, not by the
person dismissing it, so the caller's own-deletions query cannot see it. On a
relay that does not enforce NIP-09 for kind 1059 — enforcement is optional and
uneven — the dismissed invitation reappears on the next read. `fetchInvitations`
therefore looks for kind-5 events naming each wrap and honours those signed by
that wrap's own pubkey, which is NIP-09's authorization rule applied locally.

Dismissals are also matched by **event coordinate**, not only by wrap id, so
re-sending the same invitation under a new wrap cannot resurrect it.

**5. A malformed `start`/`end` degrades to `created_at`.**
Upstream's `Number(value) * 1000` yields `NaN` for a junk row, and an event with
a `NaN` begin silently disappears from every date-range query — the user never
sees it again and has no way to find out why. A visible event at the wrong time
is a better failure than an invisible one.

**6. Relay URLs are normalized** (lowercased host, no trailing slash) before use,
so `wss://nos.lol/` and `wss://nos.lol` are one socket and one subscription
rather than two.

## Costs

- Item 1 rejects wraps that upstream would surface. That is the intent, but it
  means the two clients can show different inboxes when malformed wraps are
  present.
- Item 4 costs one extra query per inbox read.
- Every item is a place where this SDK and upstream have diverged on purpose,
  and each needs re-checking when upstream's own version of it changes.
