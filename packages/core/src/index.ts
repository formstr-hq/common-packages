// @formstr/core — shared infrastructure for the Formstr super-app

// Signer
export {
  SignerManager,
  signerManager,
  LocalSigner,
  NIP07Signer,
  NIP46Signer,
  DeferredSigner,
  createDriveSignerAdapter,
  SignerUnavailableError,
  signerPool,
} from "./signer/index.js";
export type {
  NostrSigner,
  SignerMethod,
  SignerState,
  SignerObserver,
  Nip46Connection,
  Nip46Builder,
  BunkerLike,
  DriveSignerAdapter,
} from "./signer/index.js";

// Runtime
export {
  NostrRuntime,
  defaultNostrRuntime,
  nostrRuntime,
  setNostrRuntime,
  getNostrRuntime,
  resetNostrRuntime,
  EventStore,
  SubscriptionManager,
} from "./runtime/index.js";
export type { SubscriptionHandle, NostrRuntimeContract, SubscribeOptions } from "./runtime/index.js";

// Relay
export {
  RelayManager,
  relayManager,
  OutboxService,
  outboxService,
  MODULE_DEFAULT_RELAYS,
} from "./relay/index.js";
export type { RelayConfig } from "./relay/index.js";

// Blossom
export { BlossomClient, createBlossomAuthEvent } from "./blossom/index.js";
export type { BlossomUploadResult } from "./blossom/index.js";

// Crypto
export {
  nip44Encrypt,
  nip44Decrypt,
  nip44SelfEncrypt,
  nip44SelfDecrypt,
  createRumor,
  createSeal,
  createWrap,
  wrapEvent,
  wrapManyEvents,
  unwrapEvent,
  encodeNKeys,
  decodeNKeys,
  aesGcmEncrypt,
  aesGcmDecrypt,
  encryptFileWithKey,
  encryptFileWithExistingKey,
  decryptFileWithKey,
} from "./crypto/index.js";

// Linking
export {
  createRef,
  parseRef,
  resolveRef,
  createTagRef,
  parseTagRef,
  MODULE_ROUTES,
} from "./linking.js";
export type { ModuleRef, ModuleType } from "./linking.js";

// Types
export type {
  NostrEvent,
  SignedEvent,
  ModuleName,
  AsyncResult,
  NaddrParams,
  NeventParams,
  Tag,
  EventAddress,
  UserProfile,
} from "./types.js";
