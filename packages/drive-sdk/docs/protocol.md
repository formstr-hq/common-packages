# The Formstr Drive protocol, as implemented

This is the single reference for `@formstr/drive-sdk`: what goes on the wire (§1–§8), what the SDK covers and
leaves to the host (§9), where and why it differs from the app (§10), and how it is verified and kept in sync
(§11). Nothing about the protocol is documented anywhere else; the README only shows how to call the API.

**Ground truth:** [`formstr-hq/formstr-drive`](https://github.com/formstr-hq/formstr-drive) at
`0064bffcef4ecf73ae153894cce6a75b674f014d` (branch `feat/seekable-previews`, PR #72, top of the
stacked PRs #69–#72), **read from source**. Not from a README, not from the NIP text alone, not from another
client's copy of the protocol. Where the app and the spec disagree, the app is what real drives contain, so the
SDK's **reader** follows the app while its **writer** follows the spec (§3, §10).

Each section names the app function it mirrors.

---

## 1. Kind and event conventions

There is one kind: **`34578`**, addressable (replaceable per `pubkey` + `d`). What an event *is* is
its `t` tag.

| `t` | `d` | Encrypted to | Signed by | Role |
|---|---|---|---|---|
| *(none)* | `0:<identity pubkey>` | identity key (NIP-44 to self) | **identity** | the Drive Key |
| `files` | file id | Drive Key | Drive Key | file metadata |
| `folder` | folder id | Drive Key | Drive Key | folder metadata (SDK; the app has none) |
| `shared-file` | `s-<8 hex>` | ephemeral share key | Drive Key | a shared file |
| `container` | — | ephemeral share key | Drive Key | folder share — **read-only here, never written** |
| `shared-container` | `si-<8 hex>` | Drive Key | Drive Key | "Shared by me" bookkeeping |

Every event except the Drive Key event is built by `buildEvent` (`src/events.ts`), mirroring the
app's `sharing/event.ts`:

- **tags, in this order:** `["d", d]`, `["t", subtype]`, `["client", …]`, `["encrypted", "nip44"]`,
  then any extras (e.g. `["revoked", "1"]`).
- **content:** `nip44.v2.encrypt(JSON.stringify(payload), conversationKey)`. `nip44.v2` only — the
  `encrypted` tag and the cipher cannot drift.
- **conversation key** for a secret `s`: `nip44.v2.utils.getConversationKey(s, getPublicKey(s))`
  (encrypt to yourself).
- **`created_at`:** `nextCreatedAt()` — strictly increasing within a burst, clamped to `now + 60 s`
  (§8).

The Drive Key event is the exception: `[["d", "0:<pubkey>"], ["client", …]]`, encrypted by and signed
by the **identity** signer. The identity signer's only other job is Blossom authorization (§5).

## 2. The Drive Key — `services/driveKey.ts`

### 2.1 Payload

Content, decrypted with the identity key. Three shapes are read, active key first:

```jsonc
{ "encryptionKey": "<64 hex>" }                                  // current, no history
{ "encryptionKey": "<64 hex>", "previousKeys": ["<64 hex>", …] }  // current, after rotation
[["encryptionKey", "<64 hex>"]]                                   // legacy array-of-tags
```

The SDK writes the first two (`previousKeys` omitted when empty). Malformed entries inside
`previousKeys` are skipped; a payload with no usable active key is unreadable.

**Keyring.** `active` = the active key of the newest readable event; `previous` = every other key
from every readable event, deduplicated, in encounter order. Newest = highest `created_at`, ties to
the lowest event id. File metadata is decrypted by trying each key; new events use `active`.

### 2.2 Status

`resolveDriveKeyStatus` returns a `DriveKeyStatus` (mirrors the app's), never a nullable:

| | means |
|---|---|
| `ready` | a keyring was read (`stale: true` if the newest event carries fewer keys than are provably held) |
| `empty-confirmed` | no key exists, **proven**: identity has no history *and* every configured relay answered a control query |
| `unresolved` | anything else — timeout, unreachable relay, an event that exists but cannot be read, no way to prove coverage |

Lookup: `observe([{kinds:[34578], authors:[identity], "#d":["0:<identity>"]}])`, held open for
`settleMs` (3 s) after the local EOSE — EOSE is the cache replay, not the network — up to `timeoutMs`
(20 s). A cache-only (`localOnly`) lookup proves nothing about relays and can never be `empty-confirmed`.

### 2.3 The mint hazard, and the rules that contain it

The Drive Key is one secp256k1 secret in one **replaceable** event per identity; everything else is encrypted
and signed with it. A second Drive Key event does not sit beside the first — it **replaces** it on every relay
that accepts it. Every file under the original key is then unreadable, and nothing the SDK or the app can do
brings the key back.

SDK 0.1.0 made this easy to do by accident: its lookup returned `null` on a timeout, and its README suggested
`current ?? await updateEncryptionKey(...)`. `null` there means *"I did not hear an answer"* — which is exactly
what an existing user looks like on a cold cache or a flaky relay. formstr-drive's own source documents an
incident of this shape and guards against it heavily. So:

**Nothing creates a Drive Key unless absence has been proven, right now, by a lookup that started at the
decision.**

1. **Three states, not a nullable** (§2.2). *"A key exists but I can't read it"* is `unresolved`, not "no key".
2. **`empty-confirmed` needs a positive proof, or it is never emitted.** Ported from the app's
   `identityHistory.ts`: (a) the identity has published nothing under kinds `0/3/10002/34578`, and (b) **every**
   relay in `configuredRelays` answered an identity-independent control query just now, established through
   `store.seenOn`. Without both a `seenOn` on the store and the host's `configuredRelays` (or the store's own
   `relays`), the SDK cannot prove coverage and returns `unresolved` — the host decides what a first-time user is.
3. **Minting re-resolves, uncached.** `mintDriveKey` takes no status argument. It resolves from scratch
   immediately before publishing and refuses (`DriveKeyMintRefusedError`) unless that verdict is
   `empty-confirmed`; a cached verdict of any age cannot authorize it. It throws rather than returning `null`, so
   `current ?? mint(...)` cannot be written by mistake. The optional durable `marker` (host-owned storage)
   refuses a second mint for an identity that already minted, and is not recorded when the publish fails, so a
   new user can retry. Concurrent Drive Key publishes for one identity are refused.
4. **The cache is bounded.** `createDriveKeyStatusCache` keeps `ready` (keys are only ever added), keeps
   `empty-confirmed` for 30 s (`EMPTY_CONFIRMED_TTL_MS` — a proof about a moment, not the identity), and never
   keeps `unresolved` (a statement about right-now connectivity).
5. **Nothing may drop a key.** One internal function publishes Drive Key events, and it throws
   `DriveKeyDroppedError` unless every already-known secret is in the event. Rotation (`rotateDriveKey`) moves the
   old active key into `previousKeys`; `healDriveKey` republishes the union when a relay's newest event is
   narrower than what is provably held (an earlier accidental mint).
6. **Reading never writes.** Only `mintDriveKey`, `rotateDriveKey` and `healDriveKey` publish. They are
   identity-signed, use the shared `nextCreatedAt`, and must also beat the `created_at` of the event being
   replaced.

**What the proof is worth.** `seenOn` in local-relay is documented as *"NOT an inventory of who has the event …
usually ONE relay (the source)"*. The control query asks for up to five events (kinds `1/0/3/10002`) and unions
the relays that delivered each, so full coverage of a large relay set is a demanding test: it fails safe
(`unresolved`) far more often than it wrongly passes. That is the intended direction of error. It is still only as
good as `configuredRelays`: if the host lists fewer relays than its lookups fan out to, the proof covers fewer
relays than it should. Pass the real set. Identity history is **never cached** here (the app caches `"new"` for
the life of the page; a stale `"new"` is precisely what would authorize a wrong mint).

**Consequences.** A host that cannot supply the relay list and `seenOn` never gets `empty-confirmed` and must
decide itself (for example, by asking the user to confirm "I have never used Formstr Drive"). First-run latency
is real: the lookup waits out the settle window, then an existence query, then the control query. A brand-new
identity always waits the full `timeoutMs` for "any history?", because absence cannot be known sooner.

## 3. File metadata — `types/metadata.ts`, `services/fileIndex.ts`

**Written** (spec shape, strict — `fileSchema`):

```jsonc
{
  "name": "…", "unencryptedFileHash": "<64 hex>", "size": 0, "type": "text/plain",
  "parent": "<folder id, or empty for root>", "uploadedAt": 1700000000000,
  "servers": ["https://…"],              // where the blob actually landed
  "encryptionKey": "<64 hex>", "encryptionAlgorithm": "aes-gcm",
  "blobHash": "<64 hex>", "chunkSize": 65536, "previewHash": "<64 hex>?"
}
```

A tombstone is the same object plus `"deleted": true`, republished at the same `d`.

**Read** (lenient — `readFileMetadata`): the spec shape and the app's shape. The app writes
`{ id, name, size, type, folder: "/a/b", uploadedAt, server, servers?, encryptionKey, encryptionAlgorithm,
blobHash?, chunkSize?, chunks?, unencryptedFileHash?, previewHash?, deleted? }`.

| App field | Read as |
|---|---|
| `server` (no `servers`) | `servers = [server]` |
| `folder` (a path string) | `folderPath` — a path, **never** turned into a `parent` id |
| `deleted: true` | tombstone: excluded from listings, but it still blocks older versions |
| `id` in the payload | ignored; the event's `d` tag is the id |
| `unencryptedFileHash` absent | fine; integrity is verified only when it is present |
| `chunks` without `blobHash` | `legacyChunked` — lists, cannot download (§10.1) |

A `FileEntry` keeps the exact decrypted JSON as `raw`. Rename, move and delete republish `{...raw, changed}`, so
touching an app-written file never drops fields this SDK does not understand.

**Listings** key files by `d` alone, across every Drive Key pubkey: after a rotation the same file is republished
under the new key and replaces the old event. Newest `created_at` wins; equal timestamps go to the lowest id (what
relays keep). A tombstone hides the file and still blocks older versions. The relay filter is
`{kinds:[34578], authors:<all drive pubkeys>}` with **no** `#t` — legacy events may lack the tag — and other
subtypes are skipped client-side by their `t`. A bookkeeping list is deduplicated by `d`, newest wins.

**Folders:** `{ "name", "parent" }`, `t=folder`, same rules.

## 4. NIP-FS single blob — `crypto.ts`, `services/downloadFile.ts`, `rangeRead.ts`

One blob per file: every segment's ciphertext concatenated in order. `blobHash` = sha256 of the blob.

- Key: the file's `encryptionKey` secret → NIP-44 self conversation key (32 bytes), used **directly** as
  the AES-256-GCM key. No HKDF.
- Segment `i` of `n = max(1, ceil(size / chunkSize))`: plaintext is `chunkSize` bytes, the last is
  `size − chunkSize·(n−1)` (possibly 0). Ciphertext = `ct ‖ tag(16)`. No version byte, no stored nonce.
- Nonce (12 bytes): 11-byte big-endian segment index, then `0x01` on the last segment else `0x00`.
  An index that does not fit in 11 bytes is an error. Because the position and the "last" flag are in the nonce,
  reordering, truncating or appending to a blob fails the GCM tag rather than returning wrong plaintext.
- Frame length is `chunkSize + 16`, except the last: `size − chunkSize·(n−1) + 16`. Blob size is
  `size + 16·n`.
- **Stream decode:** read frames over arbitrary network chunking; a short read is
  `BlobTruncatedError`; bytes after the last frame are `BlobOverrunError`; `unencryptedFileHash`, if
  present, is verified incrementally (`IntegrityError`).
- **Range decode:** ciphertext bytes `[first·(chunkSize+16), min(blobSize, (last+1)·(chunkSize+16)) − 1]`
  cover plaintext `[start, end]`. `isLast` means the **file's** last segment. A `200` (server ignored
  `Range`) is never decoded — `RangeNotSatisfiedError`; the caller falls back to streaming.

## 5. Blossom — `blossom.ts`

| | |
|---|---|
| upload | `PUT {server}/upload`, `X-SHA-256`, BUD-02 `Authorization` (kind 24242, `t=upload`, `x=<blobHash>`) |
| preflight | `HEAD {server}/upload` with `X-Content-Length`, `X-Content-Type`, `X-SHA-256` (BUD-06) |
| download | `GET {server}/{hash}`; optional `Range: bytes=a-b` (`206` = honored) |
| exists | `HEAD {server}/{hash}` — `200` yes, `404` no, else *uncertain* (throws) |
| delete | `DELETE {server}/{hash}`, BUD-02 `t=delete`; `404` counts as success |

**Preflight classification** (`canAccept`): only **403, 413, 415** are refusals. 404 and 501 mean BUD-06
is not implemented (verified against live servers that 404 the probe and accept the PUT); 429 and 5xx are
transient per BUD-06; a timeout says nothing. All of those proceed to the real PUT.

Upload: one authorization, replayed across servers. `fallback` (the default) stops at the first server that
accepts; `replicate` tries all. Up to 3 attempts per server; 401/403/413/415 are never retried. `servers` in the
metadata lists only servers the blob landed on, and at least one must succeed.

## 6. Sharing — `services/sharing/*`

**Link:** `#shared=<naddr>&k=<64 hex>`. `naddr` = NIP-19 `{kind: 34578, pubkey: <drive pubkey>,
identifier: <d>, relays: [...]}`. The ephemeral secret rides outside it (`naddr` has no TLV for one) and
the fragment is never sent to a server. The link does not say file-or-folder — the fetched event's own
`t` tag does. Decoding returns `null`, never throws, on a malformed link, a `k` that is not 64 hex, or an
naddr of another kind. A full URL containing the fragment is accepted.

**Create** (`createFileShare`): generate an ephemeral secret; publish `t=shared-file`, `d=s-<8 hex>`,
payload = the file's own decrypted JSON (`raw`, so an app-shaped file stays app-shaped and a spec-shaped one
stays spec-shaped), encrypted to the ephemeral key, signed by the Drive Key. Relay hints in the link are the
relays in the publish result whose status is `accepted` — never an assumed default set. Then write the
bookkeeping event; if that fails the link still works, so the failure is reported (`infoWritten: false`), not
thrown.

**Bookkeeping** (`t=shared-container`, `d=si-<8 hex>`, encrypted to the Drive Key), written for file
shares too:

```jsonc
{ "v": 1, "kind": "file", "name": "…", "source": { "type": "file", "id": "<file id>" },
  "coordinate": "34578:<drive pubkey>:s-…", "relays": ["wss://…"], "members": [],
  "encryptionKey": "<ephemeral secret hex>", "revokedAt": 1700000000 /* once revoked */ }
```

`listShares` decrypts these with the keyring, keeps the newest per `d`, rebuilds each link from
`coordinate` + `relays` + `encryptionKey`. Revoked entries stay listed.

**Resolve** (`resolveShare`): needs **no signer and no identity**. `observe({relays})` with the link's hints (per
call; no global routing), newest event at the coordinate wins; `t=container` → `FolderShareUnsupportedError`; a
`["revoked","1"]` tag short-circuits **before** decrypting; otherwise decrypt with the link key and read the file
metadata. An authenticated revoke payload also reads as revoked.

**Revoke** (`revokeShare`): a superseding event with the same `d` and `t`, encrypted to the same
ephemeral key, tag `["revoked","1"]`, `created_at` strictly newer than the original, payload
`{"v":1,"revoked":true,"at":<unix s>,"kind":"file"}`, signed by the Drive Key that authored the share.
Then rewrite the bookkeeping event with `revokedAt` (its `created_at` must beat the event it replaces:
`max(nextCreatedAt(), replaced + 1)`), and send a best-effort NIP-09 request for the share coordinate.
Revoking cannot un-disclose anything a recipient already fetched.

**Ensure** (`ensureFileShare`): idempotent. A live (non-revoked) bookkeeping entry for the same file id
returns its link; otherwise create. Concurrent calls for one file share one in-flight request.

## 7. Deletion and republish

Rename and move republish the same `d` with `created_at = max(nextCreatedAt(), previous + 1)`, encrypted
and signed by the **active** key (even if the old event was authored by a rotated key — listings key by
`d`).

`deleteFile`: (1) tombstone republish — must land, or nothing else happens; (2) NIP-09 kind 5 with
`["a", "34578:<active pubkey>:<id>"]` and `["k","34578"]`, best effort; (3) best-effort blob delete on
each of the file's servers, skipping every hash in the caller's `stillReferenced` set, which must come from a
complete index (§9.3). Each blob is independent: one failure never blocks the rest, and an orphaned blob beats a
half-deleted file.

## 8. Timestamps — `clock.ts`

`nextCreatedAt` is one shared monotonic clock for every addressable publish. Relays break equal-timestamp
ties on a replaceable event by lowest id, so back-to-back publishes at one coordinate would be a coin
flip. Each stamp is therefore strictly greater than the last — until it would run more than 60 s ahead of
the wall clock (formstr-drive #71 review): a far-future stamp baked into a signed event beats another
device's legitimate real-time edit. So after 61 stamps inside one second the value holds at `now + 60`
(non-decreasing, no longer strictly increasing). Republishes that must beat a specific event
(rename, revoke, key rotation, bookkeeping rewrite) also take `max(…, replaced.created_at + 1)`.

## 9. Scope and the host's responsibilities

The SDK covers what two clients must agree on; they do not have to share application plumbing.

### 9.1 In scope

| | |
|---|---|
| Drive Key | keyring, three-state resolve, mint / rotate / heal, all payload shapes (§2) |
| Metadata | file and folder events, signed and encrypted with the Drive Key, lenient read (§3) |
| NIP-FS blob | per-segment crypto, `streamDecrypt`, `decryptRange`, buffered encrypt/decrypt (§4) |
| Upload | BUD-06 preflight, fallback / replicate, per-server failure report (§5) |
| Dedup | `findDuplicate`, `isBlobLive`, `linkDuplicate`, `findHashesStillReferenced` |
| Edit | rename / move (files, folders), delete (tombstone + NIP-09 + guarded blob delete) (§7) |
| File sharing | link codec, share / ensure / resolve / revoke, bookkeeping, `listShares` (§6) |
| Relay access | `createRelayPoolStore`, a built-in `FileEventStore` over plain websockets (§9.2) |

### 9.2 Out of scope, and why

- **Folder sharing (`t=container`).** The app has set it aside itself ("Folder sharing is TBD" in NIP-FS). The SDK
  reads the subtype only to refuse it: `resolveShare` throws `FolderShareUnsupportedError`, `revokeShare` on a
  folder entry does too, and `buildEvent` will not author a `container`. Bookkeeping entries for folders written
  by the app are still listed.
- **Service-worker download wiring.** The SDK provides `streamDecrypt` / `downloadFileStream`; the host wires its
  own service worker to them.
- **Transfer queues and native upload drivers.** Retry policy above a single call, progress UI, background uploads.
- **A persistent file index.** The host owns its cache. The SDK's helpers take a list.
- **A durable publish outbox.** The SDK publishes through the store it is given and reports what each relay said.
  The built-in pool store keeps nothing across restarts: an event no relay accepted is not retried after the
  process exits. A host that needs durable delivery plugs in a store that has it (local-relay's `DeliveryOutbox`
  does) or checks `publishResult.ok` and retries.
- **Preview generation and encryption.** `previewHash` is carried through metadata and deleted with the file;
  producing or fetching a preview is the host's.
- **BUD-03 server discovery.** A reasonable follow-up. It predates #69–#72 and is not part of this parity pass.
- **Key delivery UI.** How a share link or a Drive Key reaches another person or device.

**Runs anywhere `nostr-tools` runs, with no local-relay and no browser APIs.** The SDK has to work in a browser
and on a Node server (nail's bridge, an MCP tool, an agent), because the mail-attachment code that uses it runs
identically on both sides. `@formstr/local-relay` cannot be a requirement: it is a Web Worker backed by IndexedDB,
so nothing that needed it could run on Node. The core therefore depends on `nostr-tools` and nothing else
Nostr-shaped. `FileEventStore` stays a small structural contract (`observe`, `publishEvent`, optional `seenOn`,
optional `relays`), so a host that already owns a relay layer can inject it; `@formstr/drive-sdk/local-relay` is a
small optional adapter for that case and imports nothing from local-relay (no package dependency, not even an
optional peer). A plain pool has no persistent cache, so its end-of-stored-events means "the relays answered", not
"a local replay finished" — the settle windows already assume the slower case. Node 20 has no global
`WebSocket`, so the store accepts one (`webSocket`, e.g. the `ws` package); Node 22+ and browsers need nothing.

### 9.3 What the host must get right

- **`deleteFile` needs a complete index.** It takes a required `stillReferenced` set and never deletes a hash in
  it, but the SDK cannot know whether the list that set was built from is complete. An incomplete list looks
  exactly like "nothing else uses this hash": the shared blob is destroyed, and every surviving copy keeps listing
  normally and fails later with a 404. Only call it after a full sync. The app gates on the index reaching
  **EOSE** — not on "the store is non-empty", because a partially loaded store is indistinguishable from a
  complete one to this check (`isFileIndexReady` in `fileIndex.ts`). Do the same.
- **`ensureFileShare` needs a completed share list.** If `knownEntries` is passed it must have finished its first
  load; an unloaded empty list looks like "never shared" and creates a duplicate.
- **Hosts decide first-run.** Without a relay list and `seenOn` the SDK never says a drive is empty (§2.3).

## 10. Where the SDK deliberately differs from the app

The rule (§3): **read leniently, write the spec.** The app's `folder` is a path string; the spec's `parent` is a
folder id, and no mapping between them avoids inventing data.

### 10.1 Kept on purpose

1. **Legacy per-chunk files list but do not download.** The per-chunk layout used a different cipher
   (`aesGcmDecryptBytes`, HKDF per chunk, random nonces) that the SDK does not implement. `downloadFile`,
   `streamDecrypt`, `decryptRange` and `linkDuplicate` throw `LegacyChunkedFileError` — never a partial or garbled
   read — and `isBlobLive` / `findDuplicate` never offer one for reuse. `createFileShare` refuses one for the same
   reason. `deleteFile` tombstones them but reports their chunk blobs as skipped.
2. **App-shaped files cannot be moved.** `moveFile` throws `AppShapedFileError`; moving would mean turning a path
   into a parent id. Renames work and are lossless (`raw`, §3).
3. **Folders keep the spec's parent ids.** The SDK's folders (`t=folder`, `parent` ids) are ahead of the app,
   which has no folder events. They are not regressed to paths.

### 10.2 Deviations from the app, all toward safety

- **Tombstone before blobs.** `deleteFile` publishes the tombstone first and stops if it fails, so a failure never
  leaves a listed file whose blob is already gone. The app deletes blobs first.
- **Revoke does not request deletion of the bookkeeping event.** The app's NIP-09 courtesy request includes the
  info coordinate; on relays that honor kind-5 for addressable events that makes the revoked entry vanish from
  "Shared by me", which is the handle for retrying a failed revoke. The SDK asks only for the share coordinate.
- **Listing tie-break is the lowest event id**, as relays keep (NIP-01).
- **Bookkeeping is deduplicated by `d`**, newest wins; the app lists every event it is handed.
- **Upload defaults to `fallback`**, not "upload to every server".

### 10.3 Known gaps

- **Share viewer interop.** The app's shared-file viewer downloads from `file.server`. A share of a
  **spec-shaped** file has `servers[]` and no `server`, so the app may not be able to open it until it
  dual-reads. This follows directly from "write the spec shape", is an app-side fix, and is out of scope here.
  Shares of app-written files are unaffected.
- **The app's own timestamps.** The app stamps its metadata events with the plain wall clock, not a monotonic one,
  so two edits inside one second tie and relays keep the lower id. The SDK's `nextCreatedAt` avoids this for what
  it writes; it cannot fix what the app writes.

## 11. Provenance, verification and keeping in sync

**Why a pin.** SDK 0.1.0 implemented NIP-FS from the spec text while the app kept moving (single-blob encryption
#69, dedup and upload preflight #70, file and folder sharing #71, seekable previews #72). Nothing compared the SDK
against what the app actually publishes, so every test checked the SDK against the SDK. The wire format is now read
from the app's source at the pinned SHA above. (The list of what changed for callers is the README's "Upgrading
from 0.1".)

**What is verified.** What the SDK **writes** — share links and events, revoke and bookkeeping events, Drive Key
events, uploaded metadata — is decoded in `test/interop.test.ts` and `test/sharing.test.ts` with stock
`nostr-tools` (`nip19.decode`, `nip44.v2.decrypt`) and no SDK code in the decode path. What it **reads** is tested
against both the spec shape and the app's shape written out by hand, including all three Drive Key payload shapes,
tombstones and legacy chunked files (`test/signing.test.ts`, `test/sharing.test.ts`, `test/blob.test.ts`).

**What is not verified.** An earlier revision also checked the SDK against vectors generated by running the app's
own code at the pinned SHA. They were removed so that nothing executable depends on a specific commit staying
reachable (the pinned commit lives on a feature branch and is not an ancestor of `main`, since the PRs were
squash-merged). The cost is real: nothing in CI now proves the SDK decodes what the app *actually* emits. Until that
is automated again, re-check by hand before a release: diff the app's `src/` against the pinned SHA.

**To update when upstream moves:** diff the app against the pinned SHA, change this file first, the codecs second,
and bump the SHA at the top of this file last. Upstream `main` (`edfb27c`, after #69–#72 were merged) differs from
the pinned tree only by two lines adding `wss://relay.formstr.app` to the default relay lists in
`src/utils/common.ts`, which is not part of the wire format. If the pin ever has to be re-anchored, `edfb27c` is the
durable equivalent.
