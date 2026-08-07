# Using `@formstr/local-relay`

A complete guide to wiring and using the local relay — a NIP-01 Web Worker
"relay" backed by a local store, plus an intent-only data layer for Nostr apps.

---

## Table of contents

1. [Mental model](#1-mental-model)
2. [Install](#2-install)
3. [The three subpath exports](#3-the-three-subpath-exports)
4. [Quick start (5 minutes)](#4-quick-start-5-minutes)
5. [Wiring it up, step by step](#5-wiring-it-up-step-by-step)
6. [The `DataLayer` API](#6-the-datalayer-api)
7. [Reading: `observe` and cache-only reads](#7-reading-observe-and-cache-only-reads)
8. [Writing: `publish`](#8-writing-publish)
9. [Scopes, filters, and feed assembly](#9-scopes-filters-and-feed-assembly)
10. [The kind registry](#10-the-kind-registry)
11. [Relays, routing, and health](#11-relays-routing-and-health)
12. [Authentication (NIP-42)](#12-authentication-nip-42)
13. [Lifecycle: pause / resume / accounts](#13-lifecycle-pause--resume--accounts)
14. [Storage and pruning](#14-storage-and-pruning)
15. [Advanced: building your own worker / `RelayService`](#15-advanced-building-your-own-worker--relayservice)
16. [Testing](#16-testing)
17. [Wrapping in React (or any reactive host)](#17-wrapping-in-react-or-any-reactive-host)
18. [FAQ / gotchas](#18-faq--gotchas)

---

## 1. Mental model

The single load-bearing principle:

> **The app can only _declare interests_ (`observe`) and _publish_. It never opens
> a connection on a whim.**

Everything else follows from this. The Web Worker (`RelayService`) owns **every**
connection decision. It looks at the union of every active interest, dedupes them
by filter-hash, routes them per NIP-65 (outbox model), and decides if/when/how to
touch a relay. There is deliberately **no** `fetch`, `sync`, `reconnect`, or
`resetRelays` verb anywhere in the app-facing API.

Consequences you can rely on:

- **Presentation scales independently of the network.** Ten components observing
  the same scope share **one** upstream subscription. UI churn (mounting,
  unmounting, re-rendering) never opens or closes a socket directly.
- **Reads are cache-only.** `fetchById` / `fetchReplaceable` and any `localOnly`
  observe serve from the local store and **never** trigger a network fetch. The
  worker keeps the store warm on its own and **enriches** it (referenced `e`/`q`
  events + author `kind:0` profiles for scopes it syncs).
- **Retry is just another publish.** The worker, not the app, reaches dead relays.

```
┌─────────────────────────── main thread ───────────────────────────┐
│                                                                    │
│   your UI  ──observe / publish──►  DataLayer  ──►  LocalRelayClient │
│      ▲                                                     │       │
│      └────────── onEvent / onEose / results ◄─────────────┘       │
└────────────────────────────────│ Channel (postMessage) │──────────┘
                                  ▼
┌─────────────────────────── Web Worker ────────────────────────────┐
│   RelayService  ─►  EventDB (store)  ─►  IndexedDB (persistence)    │
│        │                                                           │
│        └─►  RelayPool / SyncEngine  ──►  wss:// relays (sockets)    │
└────────────────────────────────────────────────────────────────────┘
```

---

## 2. Install

```bash
pnpm add @formstr/local-relay nostr-tools
```

`nostr-tools` is a peer you'll use for signing/encoding (`finalizeEvent`,
`nip19`, etc.). The package itself depends on `nostr-tools` for verification.

You need a bundler that supports `new Worker(new URL(..., import.meta.url))`
(Vite, webpack 5, Rollup, etc.). Examples below assume Vite.

---

## 3. The three subpath exports

| Import | What you get | Runs where |
| --- | --- | --- |
| `@formstr/local-relay` | The engine + contract: `DataLayer`, `LocalRelayClient`, `RelayService`, `workerChannel`, scopes/feed/kinds, storage adapters. Pure JS. | main thread **and** worker |
| `@formstr/local-relay/worker` | A ready-made Worker entry (IndexedDB + real sockets). Point a `Worker` at it. | worker only |
| `@formstr/local-relay/testkit` | `makeEvent`, `FakeSocket`, `fakeSocketFactory` for tests. | tests |

---

## 4. Quick start (5 minutes)

```ts
import {
  DataLayer,
  LocalRelayClient,
  workerChannel,
} from "@formstr/local-relay";
import { finalizeEvent, generateSecretKey, type EventTemplate } from "nostr-tools";

// 1) Spawn the worker (the ready-made entry) and wire the client.
const worker = new Worker(
  new URL("@formstr/local-relay/worker", import.meta.url),
  { type: "module" }
);
const client = new LocalRelayClient(workerChannel(worker));

// 2) Tell the worker which relays the user reads from (routing input, not a command).
client.setUserRelays(["wss://relay.damus.io", "wss://nos.lol"]);

// 3) Build the data layer with a signer.
const sk = generateSecretKey(); // demo only; use a real signer in production
const dataLayer = new DataLayer({
  client,
  sign: async (t: EventTemplate) => finalizeEvent(t, sk),
});

// 4) Declare an interest — the worker decides the network.
const handle = dataLayer.observe(
  [{ kinds: [1], authors: ["3bf0c63f...459d"] }],
  {
    onEvent: (e) => console.log("note", e.id, e.content),
    onEose: () => console.log("local replay done — live tail now"),
  }
);

// 5) Publish something.
const { event, result } = await dataLayer.publish({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "hello nostr",
});
console.log(`accepted by ${result.accepted}/${result.total} relays`);

// later…
handle.unobserve();
```

---

## 5. Wiring it up, step by step

### 5.1 The worker

The simplest path is the ready-made entry — no worker file of your own:

```ts
const worker = new Worker(
  new URL("@formstr/local-relay/worker", import.meta.url),
  { type: "module" }
);
```

That entry wires `RelayService` to the real Worker globals: a `selfChannel`,
the real `WebSocket` factory, `nostr-tools` verification, and a shared IndexedDB
store named `"shared"`. If you need a different store name or custom options,
write a one-file worker yourself — see [§15](#15-advanced-building-your-own-worker--relayservice).

### 5.2 The channel + client

`workerChannel(worker)` adapts the `Worker` to the internal `Channel` interface.
`LocalRelayClient` is your main-thread handle; it owns subscription ids and routes
frames back to your callbacks.

```ts
const client = new LocalRelayClient(workerChannel(worker), {
  // optional — only needed for NIP-42 AUTH (see §12)
  onSignRequest: async (template) => mySigner.signEvent(template),
});
```

### 5.3 The data layer

`DataLayer` is the intent-only surface your app code should talk to. It needs the
client and a `sign` function:

```ts
const dataLayer = new DataLayer({
  client,
  sign: async (template) => mySigner.signEvent(template), // local / NIP-07 / NIP-46
});
```

### 5.4 (Optional) install it as a singleton

For non-React code (helpers, contexts) there's an ambient accessor:

```ts
import { setDataLayer, dataLayer } from "@formstr/local-relay";

setDataLayer(new DataLayer({ client, sign }));

// anywhere later, at module scope:
dataLayer.observe(/* … */); // resolves the bootstrapped singleton lazily
```

`getDataLayer()` throws if accessed before `setDataLayer` runs.

---

## 6. The `DataLayer` API

| Method | Purpose | Network? |
| --- | --- | --- |
| `observe(filters, handlers, options?)` | Declare a standing interest. Returns an `ObserveHandle`. | Worker decides (unless `localOnly`) |
| `fetchById(id)` | Resolve one event by id from cache. | **Never** |
| `fetchReplaceable(kind, pubkey)` | Current value of a replaceable event (profile, relay list) from cache. | **Never** |
| `publish(template)` | Sign + store locally + send upstream. Returns `{ event, result }`. | Yes |
| `publishEvent(event, opts?)` | Publish an already-signed event (lists, diagnostics retry). `opts.relays` are explicit target hints (e.g. a recipient's DM inbox). | Yes |
| `addEvent(event)` / `addEvents(events)` | Add events to the local store (optimistic / out-of-band). | No |
| `relayHealth()` | Live connection health of the user's relays. | Read-only observation |
| `seenOn(eventId)` | Relays a cached event was opportunistically observed on (usually one — the source; good for relay hints, not a "who has it" count). Returns `string[]`. | Read-only observation |
| `online()` | Whether a user relay is connected now or was within the last 30s (debounced). Returns `boolean`. | Read-only observation |
| `retryDelivery(eventId?)` | Re-attempt delivery of outbox records that exhausted automatic retries (one event, or all failed). | Yes (worker decides) |
| `diagnostics()` | Read-only snapshot of worker state (paused, interests, upstream routing, cache, enrichment). | Read-only observation |
| `setActiveAccount(pubkey \| null)` | Retarget scope on account switch. | No |
| `setUserRelays(relays)` | The user's read relays — a routing-policy input. | No |
| `setSearchRelays(relays)` | Dedicated NIP-50 read relays; an empty set restores ordinary-read fallback. | No |
| `setDmRelays(relays)` | The user's NIP-17 DM inbox relays (kind 10050) — where the kind-1059 stream reads. | No |
| `addGossipRelay(url)` / `removeGossipRelay(url)` | Add/remove a discovered relay to the gossip pool (fetch referenced/missing events). | Discovery only |
| `pause()` / `resume()` | Lifecycle hints (backgrounded / foregrounded). | Worker decides |

> Note: `setUserRelays` and `setSearchRelays` exist on both `LocalRelayClient` and
> `DataLayer`. Call them once early (and again whenever their configured sets
> change); calling either surface is equivalent.

---

## 7. Reading: `observe` and cache-only reads

### 7.1 The shape of an observe

```ts
const handle = dataLayer.observe(filters, handlers, options);
```

- `filters: Filter[]` — standard NIP-01 filters.
- `handlers`:
  - `onEvent(event)` — fired for every matching event: first the **cache replay**,
    then the **live tail**.
  - `onEose?()` — fired once, after the **local** replay is drained. This means
    "you've now seen everything in the cache"; live events keep coming after.
- `options.localOnly?: boolean` — when `true`, a pure store read that triggers
  **no** network. When omitted/false, the worker also keeps the scope warm upstream.

The returned `ObserveHandle`:

```ts
interface ObserveHandle {
  id: string;
  update(filters: Filter[]): void; // re-declare with new filters (e.g. wider window to paginate)
  unobserve(): void;               // drop the interest
}
```

### 7.2 Pagination is `update`, not `fetch`

To load older items, **widen the window** by re-declaring the same handle:

```ts
const handle = dataLayer.observe([{ kinds: [1], authors, limit: 50 }], handlers);

// "load older":
handle.update([{ kinds: [1], authors, until: oldestSeen, limit: 50 }]);
```

Still declarative — you've changed _what you care about_; the worker decides
whether that needs a network read.

### 7.3 One-shot cache reads

For a single value from the cache, use the promise helpers — they never fetch:

```ts
const note    = await dataLayer.fetchById("abc123…");          // Event | null
const profile = await dataLayer.fetchReplaceable(0, pubkey);   // kind:0
const relays  = await dataLayer.fetchReplaceable(10002, pubkey); // NIP-65 list
```

These work because the worker **enriches** the store as it syncs: when it pulls a
feed, it also queues the referenced `e`/`q` events and the authors' `kind:0`
profiles. So by the time you read, they're usually already cached.

### 7.4 Cache-only `observe` (reactive reads)

If you want a value **and** to be notified when enrichment lands later, observe
with `localOnly: true` instead of the one-shot helpers:

```ts
// Profiles: express NO network interest; just read what the worker enriched.
const profilesHandle = dataLayer.observe(
  [{ kinds: [0], authors: follows }],
  { onEvent: (e) => renderProfile(e) },
  { localOnly: true }
);
```

This is the pattern in the tester app: the feed observe (networked) drives
enrichment, and the profile observe (cache-only) just reads the avatars that
appear — proving enrichment + cache reads work end to end.

### 7.5 Local `search` matching

For cache replay and as a defensive gate on relay responses, a filter's NIP-50
`search` value is matched approximately: whitespace-separated terms are
lowercased and every term must occur as a substring of `event.content`. Search is
combined with the ordinary id/author/kind/time/tag fields. `limit` remains a
result-set concern.

This is intentionally not a full NIP-50 implementation: it does not parse query
operators, rank results, tokenize language, or search tags/decoded JSON fields
independently. JSON profile properties can match only because their serialized
text is in `content`. Relays may implement richer semantics, but events that fail
this local content check are not replayed or delivered to the app.

---

## 8. Writing: `publish`

```ts
const { event, result } = await dataLayer.publish({
  kind: 1,
  created_at: Math.floor(Date.now() / 1000),
  tags: [],
  content: "gm",
});
```

What happens, in order:

1. `sign(template)` turns it into a full signed `Event`.
2. The event is stored **locally first**, so any local interest sees it instantly
   (optimistic UI for free).
3. It's sent upstream. The worker routes it to the author's **write** relays
   (outbox) ∪ the user's relays, plus the **inbox** relays of any `p`-tagged
   pubkey (gossip delivery of mentions).

`result: PublishResult`:

```ts
interface PublishResult {
  ok: boolean;                       // accepted by at least one relay
  accepted: number;
  total: number;
  relayResults: RelayPublishOutcome[]; // per-relay accepted/rejected/timeout/failed
}
```

`relayResults` is exactly the shape a publish-diagnostics modal wants. **Retry is
just another publish** (`publish` / `publishEvent`) — the worker handles reaching
dead relays; you don't manage sockets.

Already have a signed event (e.g. NIP-17 gift wraps, list edits)? Use
`publishEvent(event)`.

**Explicit relay hints.** `publishEvent(event, { relays })` folds extra target
relays into routing — the one way to reach relays the worker can't derive itself.
The motivating case is a NIP-17 gift wrap: its recipient reads from their
**kind-10050** DM inbox, which the worker can't discover for an arbitrary pubkey,
so the sender (which resolved it to compose the message) passes it here:

```ts
await dataLayer.publishEvent(giftWrap, { relays: recipientInboxRelays });
```

See §11.6 for how gift-wrap (`kind:1059`) routing works with and without hints.

---

## 9. Scopes, filters, and feed assembly

You _can_ hand-write NIP-01 filters. But the package ships an opinionated read
surface so the UI never builds a raw filter or sees a relay.

### 9.1 Scopes

A `Scope` says **which subset of the network** you want; kinds say **which event
types**:

```ts
type Scope =
  | { type: "following" }            // user.follows
  | { type: "network" }              // user.webOfTrust
  | { type: "author"; pubkey }       // a single author
  | { type: "thread"; rootId }       // a root note + its replies/quotes
  | { type: "mentions"; pubkey }     // events #p-tagging this pubkey
  | { type: "global" };              // author-less
```

### 9.2 Building filters

```ts
import { buildFilters, scopeHasInput, type ScopeUser } from "@formstr/local-relay";

const user: ScopeUser = { pubkey, follows, webOfTrust };

if (scopeHasInput({ type: "following" }, user)) {
  const filters = buildFilters(
    [1],                       // kinds
    { type: "following" },     // scope
    user,                      // resolves authors for following/network/author
    { limit: 200 }             // optional window: { since?, until?, limit? }
  );
  dataLayer.observe(filters, handlers);
}
```

- `buildFilters(kinds, scope, user, window?)` → `Filter[]`. Thread/mentions become
  tag filters; global is author-less; following/network/author resolve to an
  `authors` set (which the worker then outbox-partitions downstream).
- `resolveAuthors(scope, user)` → the author list (or `null` for non-author scopes).
- `scopeHasInput(scope, user)` → `false` when there's nothing to fetch (logged out,
  empty follows / empty web-of-trust), so you can skip empty queries.

### 9.3 Assembling a feed

`observe` hands you a stream of raw events. `assembleFeed` turns the current
snapshot into an ordered, de-duplicated display list:

```ts
import { assembleFeed } from "@formstr/local-relay";

const notes = new Map<string, Event>();
dataLayer.observe(filters, {
  onEvent: (e) => { notes.set(e.id, e); scheduleRender(); },
});

function render() {
  const list = assembleFeed(Array.from(notes.values()), { feedRootsOnly: true })
    .slice(0, 100);
  // … paint `list` (already newest-first, deduped, replies dropped) …
}
```

`feedRootsOnly` (default `true`) drops replies/reactions/reposts; dedup collapses
replaceable/addressable events to their latest version.

---

## 10. The kind registry

`assembleFeed` and friends consult a **kind registry** that knows how to treat
each event kind — its role, dedup identity, whether it's a top-level feed item,
and what it references. The defaults mirror common Nostr behavior:

| Kind | Role | Notes |
| --- | --- | --- |
| 1 | note | A note with an `e` tag is a reply → not a feed root |
| 6 | repost | references the reposted event; never a feed root |
| 7 | reaction | references the liked event; never a feed root |
| 1018 / 1070 | response | references its target; never a feed root |
| 1068 | poll | |
| 30023 | article | addressable; versions collapse via the default dedupe key |

Add support for a new kind with **one** entry — no new query function:

```ts
import { registerKind } from "@formstr/local-relay";

registerKind(9802, {           // e.g. highlights
  role: "other",
  isFeedRoot: () => true,
  // dedupeKey?: (e) => …       // defaults to id, or the replaceable key
  // relatesTo?: (e) => …       // the event this one refers to
});
```

Helpers to read the registry: `getKindDef`, `dedupeKey`, `isFeedRoot`,
`relatesTo`, `roleOf`.

---

## 11. Relays, routing, and health

### 11.1 Setting the user's relays

```ts
client.setUserRelays(["wss://relay.damus.io", "wss://nos.lol"]);
// or dataLayer.setUserRelays([...])
```

This is a **routing-policy input**, not a command to connect. The worker uses it
as the default read/write set and as a fallback for author-less scopes. Call it
again whenever the user's relay list changes; the worker reconciles (new relays
may let pending interests find a home). When the set actually changes, the worker
**reopens** its standing subscriptions so each re-targets the current relays (an
unchanged set is a cheap no-op).

### 11.2 Outbox routing (NIP-65)

For author-scoped reads and for publishing, the worker reads each pubkey's latest
`kind:10002` relay list **straight from the store** (the outbox cache _is_ the
store) and routes accordingly:

- **Reads** of an author go to that author's **write** relays.
- **Publishes** go to your write relays ∪ user relays ∪ the **read** relays of any
  `p`-tagged recipient.

You don't configure any of this — it's automatic, provided the relevant
`kind:10002` events are in the store (the worker enriches them as it syncs).

#### Dedicated NIP-50 search routing

```ts
client.setSearchRelays(["wss://relay.noswhere.com", "wss://nostr.wine"]);
// or dataLayer.setSearchRelays([...])
```

Any non-blank `search` filter routes to this dedicated set before author/outbox,
DM, user-relay, or gossip routing, even when the filter also has `authors`. Per-
interest relay hints are still added. Passing `[]` restores fallback to the
ordinary read set (user relays ∪ gossip). A changed set reopens standing search
subscriptions; an unchanged set is a no-op/reconcile.

### 11.3 Health

```ts
const health = await dataLayer.relayHealth(); // RelayHealth[]
// each: { relay, connected, connecting, reconnecting }
```

Read-only observation — it reports state, it doesn't open anything. Poll it on a
timer if you want a live status panel (the tester does so every 1.5s).

### 11.4 Diagnostics

For deeper debugging, `diagnostics()` returns a read-only snapshot of the
**worker's** internal state. Like `relayHealth`, it's pure observation — it
touches no sockets and mutates nothing.

```ts
const d = await dataLayer.diagnostics();
// {
//   paused,                                   // lifecycle flag (true after pause())
//   online,                                   // user relay connected now or within last 30s
//   interests: [{ subId, filters, sync }],    // what the app has declared
//   upstream:  [{ filterHash, filters, relays }], // what the worker is subscribed to, and where
//   relays,                                   // RelayHealth[] (same as relayHealth()), each tagged { gossip }
//   dmRelays: string[],                       // NIP-17 DM inbox relays the kind-1059 stream reads
//   searchRelays: string[],                   // configured dedicated NIP-50 relays; [] means fallback
//   gossipRelays: string[],                   // discovered relays currently in the pool
//   connections: { user, outbox, gossip, total }, // counts of CONNECTED relays by source
//   cache:     { totalEvents, eventsByKind, totalAuthors },
//   enrichment:{ queuedIds, queuedAuthors, pending },
//   delivery:  { records: OutboxRecord[], pendingRelays, failed }, // durable outbox (§11.8)
// }
```

`interests` vs `upstream` is the useful pair: you own the filters, so you can map
**feature → filters → relays** to see which relay is serving which part of your
UI. The `upstream[].relays` are *candidate* relays selected by the applicable
search, DM, author/outbox, or ordinary-read policy — potentially a superset of
the sockets actually opened, since outbox routing caps per-relay author lists.

For search debugging, compare `searchRelays` with the `search` filters in
`interests` and their entries in `upstream`: a configured set should appear as
the candidates; `searchRelays: []` means those entries intentionally show the
ordinary-read fallback instead.

This is the tool for telling a wedged **client** apart from a wedged **worker**
after suspend/resume. Two tells:

- `paused: true` while the app is foregrounded → a `resume()` was dropped; the
  worker is ignoring new interests (`reconcile()` short-circuits while paused).
- `interests: []` while your app still holds `observe` handles → the worker was
  restarted (common when the OS kills the webview on mobile suspend) and its
  in-memory interests are gone, but the main thread never re-declared them.

### 11.5 Discovered (gossip) relays

Outbox routing (§11.2) covers *authors you follow* — it reads their `kind:10002`
write relays from the store. But some events can't be reached that way: a note
**referenced inside a DM**, an `nevent`/`nprofile` a user pastes, an `e`-tag hint
to a niche relay. The relay for those lives only in the client (e.g. after
decrypting the DM), and the author may be someone you've never synced.

`addGossipRelay` feeds those discovered relays to the worker:

```ts
// client decrypts a DM, parses an nevent → { id, relays: [hint] }
dataLayer.addGossipRelay(hint);                  // tell the worker about it
dataLayer.observe([{ ids: [id] }], { onEvent }); // plain networked observe — no relay param
// worker fetches { ids: [id] } from userRelays ∪ gossip pool → finds it on `hint`
```

Key properties:

- **Separate from `setUserRelays`.** The gossip pool is *discovered extras used to
  find events*. It never becomes a publish target, and clearing user relays
  doesn't touch it.
- **Read/discovery only.** Used on the batched discovery path — author-less fetches
  (`{ ids }`, `{ "#e" }`, …) and enrichment of referenced events — **not** the
  author-feed firehose, so it can't fan your feeds out across random relays.
- **Bounded (LRU).** Discovered relays come from untrusted hints, so the pool is
  capped (default 64, `maxGossipRelays` on the worker) to limit the
  amplification/connection blast radius; re-adding a url marks it most-recent.
- **Ephemeral.** Not persisted — a worker restart starts with an empty pool. The
  *events* you fetched are already in IndexedDB; re-deriving a hint from a stored
  DM is cheap, and not persisting untrusted relay URLs is the safer default.
- **Observable.** `diagnostics().gossipRelays` lists the pool;
  `diagnostics().connections.gossip` and the `gossip` flag on each `relayHealth()`
  entry let you show "connected to N discovered relays" in the UI:

  ```ts
  const health = await dataLayer.relayHealth();
  const discovered = health.filter((r) => r.gossip && r.connected).length;
  ```

`removeGossipRelay(url)` drops a relay so future fetches stop targeting it (an
already-open socket closes on the next `pause()`/`resume()` cycle).

### 11.6 DM inbox relays (NIP-17)

NIP-17 gift-wrapped DMs (`kind:1059`) are delivered to the recipient's **DM inbox
relays** (their `kind:10050` list) — which are deliberately *separate* from their
general read relays. Tell the worker about the user's own inbox relays so the
standing kind-1059 stream reads from them:

```ts
client.setDmRelays(["wss://inbox.example", "wss://dm.relay"]);
// or dataLayer.setDmRelays([...])
```

How routing then works for **author-less** scopes:

- A scope whose kinds are *all* DM kinds (`{ kinds: [1059] }`) reads from
  **DM relays ∪ user relays** (user relays are the fallback so DMs still arrive
  before any `kind:10050` is known). It never touches the gossip pool.
- Every *other* author-less scope (your feeds, `{ ids }` fetches, …) reads from
  **user relays ∪ gossip** and **never** touches the DM inbox relays — so a small,
  often access-restricted DM relay doesn't get your whole feed firehose.

Like `setUserRelays`, this is a routing-policy input: call it once early and again
whenever the user's `kind:10050` changes (e.g. after store hydration). A real
change reopens the kind-1059 stream on the new inbox relays; an unchanged set is a
no-op. `diagnostics().dmRelays` reflects the current set.

**Publishing** a gift wrap (`kind:1059`) is routed to the *recipient's* DM inbox,
never the NIP-65 outbox path — a wrap is signed by a throwaway per-message key (so
the author has no write relays) and a recipient's inbox is deliberately separate
from their kind-10002 read relays. Targets, unioned:

- the explicit `relays` you pass to `publishEvent(wrap, { relays })` — the
  authoritative source, since the worker can't discover an arbitrary recipient's
  kind-10050; the sender resolves it while composing;
- any p-tagged recipient's `kind:10050` that already happens to be in the store.

Falls back to the user's relays only when neither yields anything (best-effort, so
a wrap still goes somewhere). It never targets the recipient's read relays or the
gossip pool. Delivery is durable: relays that don't accept become outbox debt and
are re-tried on reconnect.

### 11.7 Where was an event seen? (`seenOn`)

The worker records relays it **happened to observe** each stored event on —
received from upstream on an open subscription, or accepted by on publish. Read it
back (cache-only, **never** touches the network):

```ts
const relays = await dataLayer.seenOn(eventId); // string[]
```

**Read this honestly — it is opportunistic, not an inventory of who has the
event.** Two facts bound it:

- **The worker never re-fetches an event it already holds** — the local store
  satisfies the read. So it only ever learns about relays that deliver the event
  *while a subscription is already open for some other reason*; it never goes out
  to ask "who else has this?"
- **The pool de-duplicates by event id per subscription**, so on the subscription
  that fetched it, only the **first** relay to deliver it is recorded.

In practice, for a **received** note that means **usually exactly one relay** —
the one you first got it from. So for received notes:

- ✅ Good for: deriving a relay **hint** for a quote/reply (`["e", id, hint]`) —
  you need one relay that has it, and "where we got it" is exactly that; light
  provenance/debugging ("first seen on …").
- ❌ Not for: "this note is on N relays" / completeness counts. It cannot answer
  that, and making it answer that would mean re-querying relays for notes you
  already have — the exact waste the architecture avoids.

**Your own published notes are the exception — there `seenOn` is authoritative.**
A publish fans out to every target at once (your write relays ∪ user relays ∪ any
p-tagged recipient's read relays) and each relay independently returns `OK` /
reject / timeout. The worker records exactly the relays that **accepted** (`OK
true`) — i.e. the ones that confirmed they stored it. Because retry is just
another publish, a retry that finally lands on a previously-dead relay unions in.
So for an event you authored, `seenOn` *is* the set of relays that have it —
useful as a "delivered to N relays" confirmation, or to pick a hint you know is
live.

Empty if the event isn't in the store, or its source wasn't recorded.

### 11.8 Offline publishing & delivery-on-reconnect (the outbox)

`publish` is **offline-safe and durable**. The event is stored locally first (so
your own UI sees it instantly), then sent upstream. Any target relay that doesn't
accept becomes **delivery debt** in a persisted outbox, and the worker keeps
re-delivering on its own until the event lands — you don't re-publish by hand.

What's owed vs not:

- **Accepted** (`OK true`) → the relay has it; done.
- **Timeout / unreachable** → owed; retried with **exponential backoff** (capped).
- **Rejected** (`OK false`, e.g. spam/policy) → *terminal*; never retried.

Retries are driven by real reachability, not a guess: when a relay's socket
(re)connects, the worker flushes what it owes that relay; `resume()` and a backoff
timer re-attempt the rest. The outbox is **persisted** (IndexedDB), so debt
survives a worker restart and is re-attempted on boot.

Cleanup is automatic: if the event is **deleted** (NIP-09), **superseded** (a newer
replaceable), or pruned, its outbox debt is dropped — the worker won't keep trying
to deliver something that's gone.

After a bounded number of attempts a record is marked **failed** (auto-retry stops,
but it's *kept*, not dropped). Surface and retry these manually:

```ts
const { delivery } = await dataLayer.diagnostics();
// delivery.records: OutboxRecord[]  (each: { eventId, pending, attempts, nextAttemptAt, failed })
// delivery.pendingRelays: number    (owed pairs still auto-retrying)
// delivery.failed: number           (records awaiting a manual retry)

dataLayer.retryDelivery(eventId); // re-arm one failed delivery
dataLayer.retryDelivery();        // re-arm all failed deliveries
```

### 11.9 Online state

```ts
const up = await dataLayer.online(); // boolean
```

`online` is **derived from real socket state**, not `navigator.onLine` (which lies
about captive portals / LAN-without-WAN): it's true if a **user relay** is
connected now, or was within the last **30s** — a debounce so a brief drop doesn't
flap the flag. It's also on `diagnostics().online`. Use it for an offline
indicator; the outbox already handles *delivery* without you gating on it.

---

## 12. Authentication (NIP-42)

If a relay challenges with `AUTH`, the worker asks the **main thread** to sign the
NIP-42 template (it can't hold keys itself). Wire it via the client option:

```ts
const client = new LocalRelayClient(workerChannel(worker), {
  onSignRequest: async (template) => {
    // return a signed Event, or null to refuse
    return mySigner.signEvent(template);
  },
});
```

Return `null` to decline (the worker handles refusal gracefully). If you omit
`onSignRequest`, all worker sign requests are refused.

---

## 13. Lifecycle: pause / resume / accounts

The worker can't observe page visibility, so you feed it hints:

```ts
document.addEventListener("visibilitychange", () => {
  if (document.hidden) dataLayer.pause();   // worker closes sockets, keeps store + interests
  else dataLayer.resume();                  // worker reopens upstream from standing interests
});
```

`pause()` closes every socket but **keeps** the store and your declared interests;
`resume()` reconciles and reopens. Enrichment queued while paused drains on resume.

On account switch:

```ts
dataLayer.setActiveAccount(newPubkey); // retargets scope; does NOT wipe the shared store
```

---

## 14. Storage and pruning

The ready-made worker persists to **IndexedDB** (store name `"shared"`) via
write-through: bursts of ingests batch into a few bulk writes; hydration loads the
store on boot; pruning runs periodically.

The default prune policy (`defaultPrunePolicy()`):

- **Protected forever** (never pruned by age or cap): `kind:0` (profiles),
  `kind:3` (contacts), `kind:10002` (relay lists), and the whole `10000–19999`
  replaceable-list range.
- **TTL by kind**: articles (`30023`) and polls (`1068`) live 30 days.
- **Default TTL**: 7 days for everything else (notes, reposts, reactions…).
- **Hard cap**: 50,000 events; oldest non-protected evicted past that.

To customize, write your own worker and pass `persistence.prunePolicy` (and/or
`debounceMs`, `pruneIntervalMs`) — see next section.

---

## 15. Advanced: building your own worker / `RelayService`

When you need a custom store name, custom pruning, or a non-IndexedDB adapter,
write a one-file worker. This is the exact pattern a host app uses:

```ts
// relay.worker.ts
/// <reference lib="webworker" />
import {
  RelayService,
  selfChannel,
  IndexedDBStorage,
} from "@formstr/local-relay";

const channel = selfChannel(self as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
});

const service = new RelayService({
  channel,
  storage: new IndexedDBStorage("my-app"),     // custom store name
  persistence: {
    debounceMs: 1000,
    pruneIntervalMs: 5 * 60 * 1000,
    // prunePolicy: { protectedKinds, ttlByKind, defaultTtlSeconds, maxEvents },
  },
  // socketFactory: customFactory,  // default = real WebSocket
  // verify: customVerify,          // default = nostr-tools verify
  // now: () => Date.now(),
});

void service.start(); // hydrate from storage, then begin write-through + pruning
export {};
```

Then point your `Worker` at it:

```ts
const worker = new Worker(new URL("./relay.worker.ts", import.meta.url), {
  type: "module",
});
```

`RelayServiceOptions`:

| Option | Default | Purpose |
| --- | --- | --- |
| `channel` | — (required) | The transport (`selfChannel(self)` in a worker) |
| `storage` | none (memory only) | `IndexedDBStorage` or `MemoryStorage` or your own `StorageAdapter` |
| `persistence` | defaults | `debounceMs`, `pruneIntervalMs`, `prunePolicy` |
| `socketFactory` | real WebSocket | inject `FakeSocket` factory in tests |
| `verify` | nostr-tools verify | event signature verification |
| `now` | `Date.now` | clock injection for tests |

Storage adapters available: `MemoryStorage` (no durability — good for tests/SSR),
`IndexedDBStorage(name)` (browser persistence), or implement the small
`StorageAdapter` interface yourself.

---

## 16. Testing

The whole client/worker protocol can be exercised **without a real Worker** over
an in-memory channel pair, and without real sockets via the testkit.

```ts
import {
  RelayService,
  LocalRelayClient,
  DataLayer,
  createChannelPair,
  MemoryStorage,
} from "@formstr/local-relay";
import { makeEvent, fakeSocketFactory } from "@formstr/local-relay/testkit";

const { client: clientCh, worker: workerCh } = createChannelPair();
const sockets = fakeSocketFactory();

const service = new RelayService({
  channel: workerCh,
  storage: new MemoryStorage(),
  socketFactory: sockets.factory,
  verify: () => true, // skip real sig checks in unit tests
});
await service.start();

const client = new LocalRelayClient(clientCh);
const dataLayer = new DataLayer({ client, sign: async (t) => makeEvent(t) });

const seen: string[] = [];
dataLayer.observe([{ kinds: [1] }], { onEvent: (e) => seen.push(e.id) });

// drive a relay: open the socket and push an event
client.setUserRelays(["wss://relay.test"]);
const sock = sockets.last("wss://relay.test");
sock.open();
sock.emit(["EVENT", "<subid>", makeEvent({ kind: 1, id: "deadbeef" })]);
```

- `createChannelPair()` — two linked in-memory `Channel`s (messages round-trip
  through JSON, so non-serializable payloads are caught).
- `makeEvent(overrides?)` — a structurally-valid event (the store never checks
  signatures, so no real keys needed).
- `fakeSocketFactory()` — records every `FakeSocket`; control them with
  `.open()`, `.emit(msg)`, `.fail()`, and inspect `.sent`.

---

## 17. Wrapping in React (or any reactive host)

The contract is framework-agnostic on purpose — React hooks live in the consuming
app, not in this package. A minimal `useEvents` is just `observe` + state:

```ts
function useEvents(filters: Filter[], options?: ObserveOptions) {
  const [events, setEvents] = useState<Map<string, Event>>(new Map());
  const key = JSON.stringify(filters);

  useEffect(() => {
    const next = new Map<string, Event>();
    const handle = getDataLayer().observe(
      filters,
      {
        onEvent: (e) => {
          next.set(e.id, e);
          setEvents(new Map(next));
        },
      },
      options
    );
    return () => handle.unobserve();
  }, [key]); // re-declare when filters change

  return events;
}
```

Because N components observing the same filters share one upstream subscription,
you can call this freely without worrying about socket fan-out.

---

## 18. FAQ / gotchas

**`fetchById` returns `null` even though the event exists upstream.**
Reads are cache-only by design. If it isn't in the store yet, you get `null`.
Express an `observe` interest in it (or its scope) and let the worker fetch +
enrich; then read.

**My `onEose` fired but I expected more events.**
`onEose` means the **local cache** replay is done. Live and freshly-synced events
arrive via `onEvent` _after_ EOSE. It is not "the network is exhausted."

**Profiles/avatars never show up.**
You need at least one **networked** observe in that scope to drive enrichment.
A `localOnly` profile observe only _reads_ what enrichment produced — it never
fetches. Also confirm `setUserRelays` was called (enrichment fetches from the
user's relays).

**Publishing succeeds locally but no relay accepted it.**
Check `result.relayResults` for per-relay reasons (rejected/timeout/failed), and
make sure `setUserRelays` is set and/or the author has a `kind:10002` in the
store for outbox routing. You usually **don't** need to retry by hand: timeout/
unreachable targets are queued in the durable outbox and re-delivered on reconnect
(§11.8). Only after a record is marked `failed` (see `diagnostics().delivery`) is a
manual `retryDelivery(eventId)` needed; a rejection (`OK false`) is terminal.

**Nothing connects.**
The worker only opens sockets when there's a networked interest **and** somewhere
to route it. With no `setUserRelays` and no `kind:10002` in the store, an
author-scoped read has no home and stays pending until relays are known.

**Multiple components, one subscription?**
Yes — interests are deduped by filter-hash. Identical filters share one upstream
subscription; that's the whole point of the architecture.

**Feeds stop loading after backgrounding/resume, and retry does nothing.**
Call `dataLayer.diagnostics()` (§11.4). If `paused: true` while foregrounded, a
`resume()` was dropped — send one. If `interests: []` while your app still holds
`observe` handles, the worker was restarted (common on mobile suspend) and lost
its in-memory interests; the main thread needs to re-declare them. See §11.4 for
the full breakdown.
