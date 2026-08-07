# Changelog

## Unreleased

### Fixed
- **NIP-17 gift wraps (`kind:1059`) are no longer misrouted on publish.** The
  publish path applied the NIP-65 outbox model to every event: author write
  relays ∪ user relays ∪ each p-tagged pubkey's kind-10002 **read** relays. For a
  gift wrap that is wrong twice over — it's signed by a throwaway per-message key
  (so the author has no write relays), and a recipient receives DMs on their
  kind-10050 **DM inbox**, which is deliberately separate from their read relays.
  In practice a wrap collapsed to the *sender's* own relays and never reached a
  recipient whose inbox wasn't in that set. Gift wraps now route to recipient DM
  inbox relays only (see Added), never to read relays or the gossip pool.

### Added
- **Explicit publish relay hints:** `publishEvent(event, { relays })` (and
  `LocalRelayClient.publish(event, { relays })`) fold extra target relays into
  routing — the one way to reach relays the worker can't derive. This is how a
  NIP-17 sender delivers a gift wrap to a recipient's kind-10050 inbox: the
  worker can't discover an arbitrary pubkey's inbox, so the sender (which
  resolved it to compose the message) passes it in. Any recipient `kind:10050`
  already in the store is folded in too; user relays remain a best-effort
  fallback. Delivery stays durable via the outbox.

## 0.5.0

### Fixed
- **Bulk-hydrated events are now delivered to interests that registered before
  hydration finished.** `EventDB.bulkLoad` (boot hydration from persistence)
  suppresses per-event change emits to avoid a fan-out storm, but it previously
  emitted nothing at all — so an interest that declared before the async load
  completed replayed an empty store, never saw the hydrated events, and (because
  the later upstream copy of the same event is a duplicate add that also doesn't
  fan out) hung forever waiting. `bulkLoad` now emits a single `reset` change,
  and `RelayCore` re-scans every live subscription against the store on `reset`,
  delivering any matches it hasn't already seen. This fixed an intermittent
  "read hangs after a reload" in consumers (e.g. a responses view stuck on
  "Loading…").

### Added
- **Per-interest read-relay hints:** `observe(filters, handlers, { relays })`
  folds the given relays into routing for that read — both the author-scoped
  (SyncEngine outbox) and author-less (gossip) paths — without mutating the
  global gossip pool. Lets a caller that already knows where data lives (e.g. a
  Nostr `naddr`'s relay hints) reach it even when the author has no NIP-65 outbox.
- **Deferred `unobserve` (`LocalRelayClientOptions.unobserveGraceMs`, default
  1000ms):** UI churn routinely drops an interest and re-declares an identical
  one within the same tick (React StrictMode's mount→cleanup→mount, or a
  re-render keyed on an async value). Tearing the upstream down on the drop and
  rebuilding it on the re-declare loses the in-flight fetch. The client now
  defers the real teardown by a grace window so the re-declare coalesces onto the
  same still-live upstream; set `0` to tear down synchronously.

## 0.4.0

- Initial versioned baseline for this workspace.
