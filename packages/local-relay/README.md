# @formstr/local-relay

A NIP-01 **Web Worker "local relay"** plus a thin, **intent-only data layer** for
Nostr apps. Pure JS — no UI framework.

## The load-bearing principle

The app can only **declare interests** (`observe`) and **publish**. It never opens
a connection on a whim. The worker (`RelayService`) owns *every* connection
decision, reconciling its upstream subscriptions from the union of active
interests (deduped by filter-hash, outbox-routed per NIP-65). So presentation
scales **independently of the network** — N components on the same scope share one
upstream subscription, and churn in the UI never opens or closes sockets directly.

Reads are **cache-only**: `fetchById` / `fetchReplaceable` and any `localOnly`
observe serve from the local store and never trigger a fetch. The worker keeps the
store warm and **enriches** it on its own affordance (referenced `e`/`q` events +
author `kind:0` profiles for scopes it syncs).

## Layout

- **engine** — `RelayService`, `EventDB`, `RelayPool`, `SyncEngine`, storage
  adapters (`MemoryStorage`, `IndexedDBStorage`), the `Channel` transport, and the
  `LocalRelayClient`.
- **contract** — `DataLayer` (`observe` / `publish` / `fetchById` /
  `fetchReplaceable` / `relayHealth` / `seenOn` / `online` / `retryDelivery`),
  plus `scope`, `feed` assembly, and `kinds`. Publishes are offline-durable: a
  persisted outbox re-delivers on reconnect.

## Usage

```ts
import { DataLayer, LocalRelayClient, workerChannel } from "@formstr/local-relay";

// Spawn the worker (see ./worker for a ready-made entry) and wire the client.
const worker = new Worker(new URL("@formstr/local-relay/worker", import.meta.url));
const client = new LocalRelayClient(workerChannel(worker));
client.setUserRelays(["wss://relay.damus.io"]);
client.setSearchRelays(["wss://relay.noswhere.com", "wss://nostr.wine"]);

const dataLayer = new DataLayer({ client, sign: async (t) => mySigner.signEvent(t) });

// Declare an interest — the worker decides the network.
const handle = dataLayer.observe([{ kinds: [1], authors: [pubkey] }], {
  onEvent: (e) => console.log(e),
  onEose: () => console.log("local replay done"),
});
// later: handle.unobserve();
```

Non-empty NIP-50 `{ search }` interests are routed to the dedicated search
relays. If none are configured they fall back to normal read relays. Cache
replay and upstream results are additionally gated by a case-insensitive,
all-terms substring match against event content, so relays that ignore
`search` cannot leak unrelated events into a subscription.

A host can wrap `observe` in whatever reactivity it likes (React hooks, signals,
stores) over this framework-agnostic contract.

## Subpath exports

- `@formstr/local-relay` — engine + contract (pure JS)
- `@formstr/local-relay/worker` — a ready-made Worker entry (IndexedDB + real sockets)
- `@formstr/local-relay/testkit` — `makeEvent`, fake socket factory for tests

## Documentation

See [`docs/USAGE.md`](./docs/USAGE.md) for the full guide — wiring, the `DataLayer`
API, scopes/feeds/kinds, routing, auth, lifecycle, storage, building a custom
worker, and testing.
