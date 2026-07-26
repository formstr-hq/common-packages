# @formstr/file-sdk

`@formstr/file-sdk` is a protocol-only JavaScript implementation of NIP-FS: encrypted file metadata on Nostr and encrypted blobs on Blossom.

It has no React, UI, storage, native, queue, service-worker, or relay-connection logic. A host application owns those concerns and supplies an initialized `@formstr/local-relay` data layer, a signer, the drive metadata conversation key, and a Blossom transport.

## Install

```sh
pnpm add @formstr/file-sdk @formstr/local-relay
```

## Upload a file

```ts
import {
  createFetchBlossomTransport,
  uploadFile,
} from "@formstr/file-sdk";

const result = await uploadFile(file, 10 * 1024 * 1024, {
  name: file.name,
  type: file.type || "application/octet-stream",
  folder: "/documents",
  server: "https://blossom.example",
  metadataConversationKey,
}, {
  dataLayer,       // initialized @formstr/local-relay DataLayer
  signer,          // { getPublicKey, signEvent }
  transport: createFetchBlossomTransport(),
  onProgress: console.log,
});
```

`uploadFile` encrypts the file, uploads all chunks, creates the encrypted kind `34578` metadata event, and publishes it through the supplied local relay. Metadata is not published if any chunk upload fails.

## Read and download files

```ts
const files = fetchFiles({ authors: [pubkey] }, {
  dataLayer,
  metadataConversationKey,
  onFiles: (files) => render(files),
});

const blob = await downloadFile(fileMetadata, {
  transport: createFetchBlossomTransport(),
  signer, // optional; creates BUD-01 GET authorization for protected Blossom servers
  onProgress: console.log,
});

files.stop();
```

`fetchFiles` declares a standing local-relay interest. It first receives cached metadata and then receives updates as the host's local-relay worker synchronizes relays. `downloadFile` decrypts every chunk and verifies `unencryptedFileHash` when metadata provides it.

## Host responsibilities

- Start/configure the `@formstr/local-relay` worker and provide its `DataLayer`.
- Provide a signer that can sign Blossom authorization events.
- Create and manage the drive metadata conversation key outside this package.
- Choose retry, UI, background, and service-worker behaviour. The SDK can be imported directly by a worker when required.
