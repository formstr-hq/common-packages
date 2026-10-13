# drive-tester

A browser app for trying `@formstr/drive-sdk` by hand, with an **inspector** that shows every SDK call and
every relay / file-server request it caused. Modelled on `apps/kanban-tester`: React + Vite, the SDK aliased
to its source (edit the SDK, the app updates), no mock, a throwaway key.

## Run it

```bash
pnpm install
pnpm --filter drive-tester dev           # http://localhost:5176
```

It talks to **real servers**. The Connect panel is prefilled with `relay.formstr.app`, `relay.damus.io`, `nos.lol`
and the Blossom server `https://nostr.download`; both lists are editable. Uploads and edits write small
**encrypted** events and encrypted files under a throwaway key made in your browser. Delete removes the blob and
tombstones the file, but relays may keep the encrypted events. Do not upload anything you would not want sitting on
a public server, even encrypted.

## What the panels do

| Panel | SDK calls |
|---|---|
| Connect | `createRelayPoolStore`, `createFetchBlossomTransport` |
| Drive Key | `resolveDriveKeyStatus`, `mintDriveKey` (enabled only when absence is proven) |
| Files | `uploadFile`, `fetchFiles`, `downloadFile`, `downloadFileStream`, `readFileRange`, `renameFile`, `deleteFile` |
| Sharing | `createFileShare`, `listShares`, `revokeShare`, `resolveShare` |

## Demo script (two browser profiles)

1. Profile A: **Resolve** the Drive Key. A brand-new key takes about 10 s (the SDK must prove nothing exists) and
   should say `empty-confirmed`; then **Mint**.
2. Upload a file (a few hundred KB shows more than one segment). Open **Inspector → Blossom**: `HEAD /upload`
   (preflight) and `PUT /upload`, and **Relays**: `EVENT kind 34578` whose content is ciphertext.
3. **Stream** and **Range**: the Range request is a single `GET` with a `Range` header; only the covering segments
   come back and decrypt.
4. **Share** → copy the link. Open it in **profile B** (a different browser profile or an incognito window, so it
   has a different identity): paste into “Open a share link”, **Resolve** → the file, from the link alone.
   Download it.
5. Back in A: **List “Shared by me”** → **Revoke**. In B, **Resolve** again → “revoked”.
6. **Delete**: tombstone + NIP-09 on the relays, `DELETE /<hash>` on the server.

## What it deliberately does not do

- It does not hide errors: failures show the SDK's typed error in the status bar and the inspector.
- Delete only removes the blob when no other file *in the list on screen* uses it. A real app must pass a
  `stillReferenced` set built from a **complete** index (protocol §9.3).
- No folders UI, no previews, no transfer queue, no persistence. Reloading keeps the throwaway key
  (sessionStorage, per tab) and re-reads everything from the relays.
- Secrets (`encryptionKey`, auth headers, secret keys) are redacted in the inspector.
