# @formstr/storage

Blossom blob storage with kind 24242 auth and NIP-44 v2 encryption.

Pulled out of the existing upload code in `nostr-forms` so other apps can reuse it.

## Install

```
pnpm add @formstr/storage nostr-tools
```

## Quick example

```ts
import { upload, download } from "@formstr/storage";
import { generateSecretKey, getPublicKey } from "nostr-tools";

const responderSecretKey = generateSecretKey();
const formAuthorPubkey = "..."; // form author's pubkey

const { metadata } = await upload({
  fileBytes,
  filename: "resume.pdf",
  mimeType: "application/pdf",
  formAuthorPubkey,
  responderSecretKey,
  blossomServer: "https://blossom.primal.net",
});

const fileBytes = await download({
  metadata,
  formEditKey: "<form-edit-key-hex>",
  uploaderPubkey: metadata.uploaderPubkey,
});
```

## What's exported

- `upload` / `download` - the high-level forms-style flow (encrypt to a pubkey, upload, return metadata)
- `BlossomClient` - raw Blossom HTTP client (BUD-01, BUD-02)
- `createAuthEvent` - kind 24242 auth event builder (BUD-11)
- `encryptFileToAuthor` / `decryptFileFromUploader` - NIP-44 v2 helpers for large payloads

The high-level `upload`/`download` matches what `nostr-forms` does today. For raw uploads (polls) or symmetric encryption (docs), use the lower-level exports directly.

## Notes

NIP-44 v2 is implemented with HKDF-SHA256 + AES-GCM since WebCrypto doesn't expose ChaCha20-Poly1305. Same approach as the existing nostr-forms code.

MIT.
