# ADR 0004 — Scope: the drive protocol, not the drive app

**Status:** accepted, 2026-09-29

## Context

formstr-drive does a great deal that is application plumbing rather than protocol: service
workers, a native Android upload service, a persistent index, an outbox. Two clients have to
agree on the bytes on the wire; they do not have to share any of that.

## Decision

**In scope — what two clients must agree on:**

| | |
|---|---|
| Drive Key | keyring, three-state resolve, mint / rotate / heal, all payload shapes |
| Metadata | file and folder events, signed and encrypted with the Drive Key, lenient read |
| NIP-FS blob | per-segment crypto, `streamDecrypt`, `decryptRange`, buffered encrypt/decrypt |
| Upload | BUD-06 preflight, fallback / replicate, per-server failure report |
| Dedup | `findDuplicate`, `isBlobLive`, `linkDuplicate`, `findHashesStillReferenced` |
| Edit | rename / move (files, folders), delete (tombstone + NIP-09 + guarded blob delete) |
| File sharing | link codec, share / ensure / resolve / revoke, bookkeeping, `listShares` |

**Out of scope, and why:**

- **Folder sharing (`t=container`).** The app has set it aside itself ("Folder sharing is TBD" in
  NIP-FS). The SDK reads the subtype only to refuse it: `resolveShare` throws
  `FolderShareUnsupportedError`, `revokeShare` on a folder entry does too, and `buildEvent` will
  not author a `container`. Bookkeeping entries for folders written by the app are still listed.
- **Service-worker download wiring.** The SDK provides `streamDecrypt` / `downloadFileStream`;
  the host wires its own service worker to them.
- **Transfer queues and native upload drivers.** Retry policy above a single call, progress UI,
  background uploads.
- **A persistent file index.** The host owns its cache. The SDK's helpers take a list.
- **A durable publish outbox.** The SDK publishes through the store it is given and reports
  what each relay said. The built-in pool store keeps nothing across restarts: an event no relay
  accepted is not retried after the process exits. A host that needs durable delivery plugs in
  one that has it (local-relay's `DeliveryOutbox` does) or checks `publishResult.ok` and retries.
- **Preview generation and encryption.** `previewHash` is carried through metadata and deleted
  with the file; producing or fetching a preview is the host's.
- **BUD-03 server discovery.** A reasonable follow-up. It predates #69–#72 and is not part of
  this parity pass.
- **Key delivery UI.** How a share link or a Drive Key reaches another person or device.

## Self-contained: no local-relay, no browser APIs

The SDK must run wherever `nostr-tools` does — a browser, a Node server (nail's bridge, an MCP tool, an
agent) — because the mail attachment code that uses it runs identically on both sides. `@formstr/local-relay`
cannot be a requirement: it is a Web Worker backed by IndexedDB, so nothing that needed it could run on Node.

So the core depends on `nostr-tools` and nothing else Nostr-shaped, and ships `createRelayPoolStore`, a
`FileEventStore` over plain websockets. `FileEventStore` stays a three-method structural contract, so a host
that already owns a relay layer can still inject it; `@formstr/drive-sdk/local-relay` is a small optional
adapter for that case and imports nothing from local-relay (no package dependency, not even an optional peer).

Consequences worth knowing: a plain pool has no persistent cache, so its end-of-stored-events means "the
relays answered", not "a local replay finished" — the SDK's settle windows already assume the slower case.
Node 20 has no global `WebSocket`, so the store accepts one (`webSocket`, e.g. the `ws` package); Node 22+
and browsers need nothing.

## The host's responsibilities, stated plainly

**`deleteFile` needs a complete index.** It takes a required `stillReferenced` set and never
deletes a hash in it, but the SDK cannot know whether the list the host built that set from is
complete. An incomplete list looks exactly like "nothing else uses this hash": the shared blob is
destroyed, and every surviving copy keeps listing normally and fails later with a 404. Only call
it after a full sync. The app gates on the index reaching **EOSE** — not on "the store is
non-empty", because a partially loaded store is indistinguishable from a complete one to this
check (`isFileIndexReady` in `fileIndex.ts`). Do the same.

**`ensureFileShare` needs a completed share list.** If `knownEntries` is passed it must have
finished its first load; an unloaded empty list looks like "never shared" and creates a
duplicate.

**Hosts decide first-run.** See ADR 0003: without `configuredRelays` + `seenOn` the SDK never
says a drive is empty.
