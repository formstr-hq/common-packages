# @formstr/drive-sdk

`@formstr/drive-sdk` implements the file portion of NIP-FS: encrypted file metadata on Nostr, encrypted blobs on Blossom, and ephemeral-key file sharing.

The package has no UI, relay connection, or key-storage policy. Applications inject a Nostr event store, signer, drive metadata conversation key, and Blossom transport.

## Drive Encryption Key

The drive key is stored in the user's kind `34578` metadata event at `d=0:<pubkey>`. Its content is encrypted to the user's own pubkey through the identity signer.

```ts
import { fetchEncryptionKey, updateEncryptionKey } from "@formstr/drive-sdk";

const current = await fetchEncryptionKey({ dataLayer, signer });
const created = current ?? await updateEncryptionKey({ dataLayer, signer });

const metadataConversationKey = created.metadataConversationKey;
```

`fetchEncryptionKey` keeps its relay interest open for up to `timeoutMs` (10 seconds by default) and returns the newest candidate observed in that window. Set `localOnly: true` for an immediate cache-only lookup. `updateEncryptionKey` rotates to a fresh drive key unless an explicit key is supplied for recovery or migration. Applications should warn users before rotation because metadata encrypted with an earlier key will no longer be readable with the new key.

## Install

```sh
pnpm add @formstr/drive-sdk
```

## Upload

```ts
import { createFetchBlossomTransport, uploadFile } from "@formstr/drive-sdk";

const result = await uploadFile(file, {
  name: file.name,
  type: file.type || "application/octet-stream",
  parent: "folder-id",
  servers: ["https://blossom.example"],
  metadataConversationKey,
}, {
  dataLayer,
  signer,
  transport: createFetchBlossomTransport(),
  onProgress: console.log,
});
```

`uploadFile` encrypts raw file segments with AES-256-GCM, concatenates them into one blob, uploads that blob to each declared server, and publishes encrypted kind `34578` metadata. The default plaintext segment size is 64 KiB and can be overridden with `chunkSize`.

## List And Download

```ts
const subscription = fetchFiles({ authors: [pubkey] }, {
  dataLayer,
  metadataConversationKey,
  onFiles: renderFiles,
});

const blob = await downloadFile(fileMetadata, {
  transport: createFetchBlossomTransport(),
  signer, // Optional BUD-01 authorization for protected servers.
});

subscription.stop();
```

Downloads try the metadata servers in order and verify both the encrypted blob hash and decrypted file hash.

## Share A File

```ts
const shared = await shareFile(fileMetadata, { dataLayer });

// Send the event coordinate and this key using a channel chosen by the app.
sendShare(shared.signedEvent, shared.sharingKey);
```

Sharing publishes a duplicate metadata event under `t=shared-file`, encrypted to a new ephemeral keypair. It does not upload another blob. The recipient can decrypt the event with `decryptSharedFileMetadata(event.content, sharingKey)` and then use `downloadFile` normally. Key delivery and folder sharing are intentionally outside this SDK.

## Folders

```ts
const created = createFolderMetadata({
  name: "Documents",
  parent: "",
  metadataConversationKey,
});
await dataLayer.publish(created.event);

const folders = fetchFolders({ authors: [pubkey] }, {
  dataLayer,
  metadataConversationKey,
  onFolders: (folders) => renderFolders(folders), // Each folder includes its d tag as `id`.
});
```

Folder events use kind `34578`, `t=folder`, and the same decoupled drive conversation key as file metadata. Renames and moves publish a replacement event with the same `d` tag.

## Lower-Level APIs

- `encryptFile` and `decryptFileBytes` implement the NIP-FS single-blob wire format.
- `createFileMetadata` and `decryptFileMetadata` handle drive-key metadata events.
- `createFolderMetadata`, `decryptFolderMetadata`, and `fetchFolders` handle virtual folders.
- `fetchEncryptionKey`, `updateEncryptionKey`, and `deriveMetadataConversationKey` implement decoupled drive keys.
- `createSharedFileMetadata` handles unpublished shared-file events.
- `fileSchema`, `isFile`, and `assertFile` expose the authoritative JSON Schema and runtime validation.
- `createFetchBlossomTransport` provides a fetch-based Blossom transport; applications may inject another implementation.
