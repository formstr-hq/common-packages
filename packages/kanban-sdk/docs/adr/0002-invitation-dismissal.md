# ADR 0002 — Dismissing an invitation deletes the wrap

**Status:** accepted, 2026-08-01 · **Supersedes:** the kind-84 opt-out on decline

## Context

Declining an invitation published a kind-84 opt-out, authored by the invitee and
tagged `["a", "32301:owner:d"]`. It worked, and it leaked: anyone watching the
relay learned that a specific pubkey had been invited to a specific private
board and turned it down. Board contents were encrypted; this handed out the
social graph in plaintext.

Deleting the wrap instead looks impossible at first. NIP-09 honours a deletion
only from the target event's own author, and a gift wrap is signed by a throwaway
key that nothing retains — so neither the recipient (not the author) nor the
inviter (no longer holds the key) can delete it.

## Decision

The inviter keeps the ephemeral key just long enough to put its nsec inside the
**encrypted rumor** as `signing_nsec`. On dismissal the recipient signs a kind-5
**as the wrap's own author**.

The same-author rule is satisfied, not bypassed. The deletion carries an
anonymous author and an `e` tag — no link to the invitee, none to the board.

Sharing the key is safe: it signs exactly one wrap, and the seal inside is signed
by the inviter's real identity key, so it cannot be used to forge an invitation
from them. Keys stay per-recipient, so one invitee cannot delete another's copy.

`fetchInvitations` also filters deleted wraps client-side. NIP-09 is a *request* —
a relay may ignore it, and one that never received it keeps serving the wrap — so
without that filter the invitation returns on every refresh.

Invitations predating `signing_nsec` have no key to sign with and still use the
kind-84 path.

## Costs

- Dismissal state now lives in two places: the deletion, and the legacy kind-84
  read path. Both are queried until legacy support is dropped.
- The client-side filter costs one extra query per fetch, keyed on the wraps'
  ephemeral authors.
- A host that surfaces `signingNsec` to users is handing out a signing key. It is
  scoped to one event, but it is still a key.

## Prior art

nostr-calendar (`deleteGiftWrapAsRecipient`, `signing_nsec` rumor tag). It relies
on the relay plus a local store; this SDK is stateless, hence the extra filter.
