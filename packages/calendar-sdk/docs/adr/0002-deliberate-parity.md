# ADR 0002 — Upstream behaviours that look like bugs and are kept anyway

**Status:** accepted, 2026-08-03

## Context

Several things `calendar.formstr.app` does look wrong on first reading, and each
one is tempting to "fix" while porting. Fixing any of them on one side alone
makes the two clients disagree about the same event — which is worse than the
original problem, and much harder to notice.

## Decision

Keep the following, and pin each with a test so the next reader argues with a
failing assertion rather than a comment.

**1. The creator gets no invitation.** `publishPrivateCalendarEvent` wraps
`event.participants` only, and `uniqueParticipants` never injects the author. A
self-wrap would put a pending invitation to your own event in your own inbox.

The comment directly above that code says the opposite ("including the creator"),
and at least one generated protocol summary repeats the comment. Source wins.

**2. Removed participants get no revocation.** There is no un-invite. Kind 84
exists only to read tombstones written by much older builds. Anyone who received
the view key keeps it — which is a property of handing out a symmetric key, not
something a protocol row can undo.

**3. Public events never carry recurrence, categories or tzid rows** even though
upstream's *reader* accepts all three. Its writer emits none of them. This is
the general rule the codecs follow: **write narrow, read wide**.

**4. Private RSVPs use a plain `now`**, not the strict-supersession stamp used
everywhere else. An RSVP is one addressable event per responder per event, so a
same-second tie needs the same person answering twice within one second.

**5. Recurrence expansion is UTC-only and ignores `start_tzid`.** Upstream has
the same limitation. A tzid-aware expansion here would compute different
occurrence times than the app showing the user the same event — the two would
disagree about *when the meeting is*, which is the worst possible thing for a
calendar to be wrong about. Fix it in both, or in neither.

**6. `["notifications","enabled"]` is never written** to a calendar list. Only
the non-default value is persisted; absence means enabled.

**7. View key encodings differ by domain and are not normalized.** Calendar
events carry nsec. (Scheduling pages, out of scope here, carry raw hex.)

**8. `start`/`end` are JSON numbers inside a private event's encrypted payload
and decimal strings on a public event's tags.** Both sides parse with `Number()`,
so the asymmetry is harmless — as long as neither side unifies it alone.

## Costs

- Items 2 and 5 are genuine product limitations that this package now
  perpetuates.
- A contributor reading only this SDK sees odd behaviour with no local
  justification, which is why each one carries a comment pointing here.

## When to revisit

When a change lands in nostr-calendar. These are joint decisions; the unblocking
move for 2 and 5 is a coordinated change in both codebases, not a patch here.
