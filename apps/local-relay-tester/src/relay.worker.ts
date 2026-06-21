/**
 * The host's worker entry — the thin platform shell. All logic lives in
 * RelayService (shipped by @formstr/local-relay); this just wires it to the
 * real Worker globals: selfChannel(self), the default WebSocket factory, and the
 * IndexedDB store. This is the pattern a host app (pollerama) uses verbatim.
 */
/// <reference lib="webworker" />
import { RelayService, selfChannel, IndexedDBStorage } from "@formstr/local-relay";

const channel = selfChannel(self as unknown as {
  postMessage: (m: unknown) => void;
  onmessage: ((e: MessageEvent) => void) | null;
});

const service = new RelayService({
  channel,
  storage: new IndexedDBStorage("local-relay-tester"),
});

void service.start();

export {};
