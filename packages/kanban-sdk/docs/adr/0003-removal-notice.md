# ADR 0003 — The removal notice is blinded, and stays kind 84

**Status:** accepted, 2026-08-01

## Context

`removeMember` published a kind-84 notice tagged `["a","32301:owner:d"]` and
`["p", removed]`, both plaintext. A relay could therefore reconstruct a private
board's entire membership history — who was added, who was evicted, when —
without decrypting anything.

Two questions came up. Should this be kind 5 instead? And is there a standard
kind that fits better?

**Kind 5 cannot express it.** There is nothing to delete: membership is a tag
inside the board's encrypted payload, and removal republishes the board (an
addressable replacement), not deletes it. A kind 5 aimed at the board would
delete the board.

**NIP-29 `9001 remove-user` is the closest standard, and is wrong here.** It is a
command *to the relay* — "relays must check if the pubkey sending the event is
capable of performing the given action" — and membership is whatever the relay
concludes from the latest 9000/9001. Published to a relay that does not implement
NIP-29 it does nothing, giving kind 84's exact semantics under a number that
promises enforcement. It also requires an `h` tag naming a NIP-29 group, which we
do not have. Borrowing it would export a guarantee we cannot honour.

No standard exists for an *advisory* removal notice, because the specs that
handle removal (NIP-29, MLS/NIP-EE) handle it by enforcement and need no notice.
Both were evaluated for the key model and rejected — see `kanban/docs/04`.

## Decision

Keep kind 84. Replace `a` and `p` with the **blinded pointer**:

```json
{ "kind": 84, "tags": [["b", "<pointer under the view key>"], ["k", "32301"]] }
```

Linking the notice to a board requires the view key. The removed member still
holds it, so they can compute the pointer and find the notice with one query —
`{"kinds":[84],"#b":[…]}` — covering every board they hold a key for. That single
cheap lookup is the notice's entire justification; without it, learning you were
removed means refetching every board in your list and diffing its member tags.

`fetchRemovalNotices` accepts the **board owner's** notices only. Every member can
compute the pointer, so an unauthenticated notice would let any member evict any
other in every client that believed it.

## `removeMember` rotates by default

Separately from the tags: dropping someone's tag revokes nothing. They keep the
view key and go on decrypting cards written *after* they were removed. Shipping
that behind a method called `removeMember` is a trap, so it now calls
`rotateBoardKey({ remove: [pubkey] })` unless told otherwise.

`{ rotate: false }` stages a removal without re-keying. That exists because each
rotation republishes every card and comment, so evicting several people wants one
rotation and not N — untag them all, then rotate once. Until that call lands,
everyone staged still has full access.

The notice's pointer is computed under the **retiring** key, before rotation. It
is the only key the removed member holds, so it is the only pointer they can
match. The notice is published after the rotation succeeds, so a failed rotation
does not announce a removal that did not happen.

## Costs

- Rotation is not retroactive. Nothing un-reads what they already read.
- The default makes `removeMember` O(cards) publishes and non-atomic — a real
  cost, accepted because the alternative silently does nothing.
- An observer still sees that the owner published *a* removal, and the owner's
  pubkey is public. Only the target and the board are hidden.
- Kind 84 is unregistered (`84` in the NIPs README is the *NIP* number, for
  kind 9802 Highlights). A future NIP could claim it; `kinds.ts` keeps the
  renumber a one-file change. Doc 07 §A1.
