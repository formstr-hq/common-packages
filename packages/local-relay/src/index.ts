/**
 * @formstr/local-relay — a NIP-01 Web Worker "local relay" + a thin, intent-only
 * data layer for Nostr apps.
 *
 * The load-bearing principle: the app can only DECLARE INTERESTS (`observe`) and
 * PUBLISH. It never opens a connection on a whim — the worker (RelayService) owns
 * every connection decision from the union of active interests, so presentation
 * scales independently of the network.
 *
 * This package is pure JS — no UI framework. The `observe`/`publish` contract is
 * framework-agnostic; a host wraps it in whatever reactivity it likes (e.g. React
 * hooks live in the consuming app). For a ready-made worker, point a `Worker` at
 * `@formstr/local-relay/worker`, or build your own with `RelayService`.
 */

// ---- core store + types ----
export type {
  Event,
  Filter,
  StoreChange,
  StoreListener,
  DBStats,
  PrunePolicy,
} from "./localRelay/core/types";
export { defaultPrunePolicy } from "./localRelay/core/types";
export { EventDB } from "./localRelay/core/EventDB";
export { generateFilterHash } from "./localRelay/core/matchFilter";

// ---- the worker-side relay assembly ----
export { RelayService } from "./localRelay/RelayService";
export type { RelayServiceOptions } from "./localRelay/RelayService";

// ---- transport (channel + client + frames) ----
export type { Channel } from "./localRelay/transport/channel";
export {
  workerChannel,
  selfChannel,
  createChannelPair,
} from "./localRelay/transport/channel";
export { LocalRelayClient } from "./localRelay/transport/LocalRelayClient";
export type {
  SubscribeHandlers,
  LocalRelayClientOptions,
} from "./localRelay/transport/LocalRelayClient";
export type {
  ToWorker,
  FromWorker,
  RelayPublishOutcome,
  RelayHealth,
  Diagnostics,
} from "./localRelay/transport/frames";

// ---- storage adapters ----
export type { StorageAdapter } from "./localRelay/storage/StorageAdapter";
export { MemoryStorage } from "./localRelay/storage/MemoryStorage";
export { IndexedDBStorage } from "./localRelay/storage/IndexedDBStorage";

// ---- the intent-only data layer (contract) ----
export { DataLayer, getDataLayer, setDataLayer, dataLayer } from "./dataLayer/client";
export type {
  DataLayerDeps,
  ObserveOptions,
  ObserveHandle,
  PublishResult,
} from "./dataLayer/client";

// ---- scope / feed assembly / kinds (the opinionated read surface) ----
export type { Scope, ScopeUser, Window } from "./dataLayer/scope";
export { buildFilters, resolveAuthors, scopeHasInput } from "./dataLayer/scope";
export type { AssembleOptions } from "./dataLayer/feed";
export { assembleFeed } from "./dataLayer/feed";
export type { KindDef } from "./dataLayer/kinds";
export {
  registerKind,
  getKindDef,
  dedupeKey,
  isFeedRoot,
  relatesTo,
  roleOf,
} from "./dataLayer/kinds";
