import { BlossomClient } from "./client.js";
import { createAuthEvent } from "./auth.js";
import { encryptFileToAuthor, decryptFileFromUploader, calculateSHA256 } from "./crypto.js";
import type { UploadParams, UploadResult, DownloadParams, FileUploadMetadata } from "./types.js";

export { BlossomClient, BlossomError } from "./client.js";
export { createAuthEvent } from "./auth.js";
export {
  encryptFileToAuthor, decryptFileFromUploader, calculateSHA256,
  uint8ArrayToBase64, base64ToUint8Array,
} from "./crypto.js";
export type {
  UploadParams, UploadResult, DownloadParams, FileUploadMetadata, AuthVerb,
} from "./types.js";

export async function upload(params: UploadParams): Promise<UploadResult> {
  const { fileBytes, filename, mimeType, formAuthorPubkey, responderSecretKey, blossomServer } = params;
  const { ciphertext, uploaderPubkey } = await encryptFileToAuthor(
    fileBytes, formAuthorPubkey, responderSecretKey,
  );
  const encryptedBytes = new TextEncoder().encode(ciphertext);
  const sha256 = await calculateSHA256(encryptedBytes);

  const authHeader = await createAuthEvent("upload", sha256, responderSecretKey);
  const client = new BlossomClient(blossomServer);
  const responseText = await client.upload(encryptedBytes, authHeader);

  let actualSha256 = sha256;
  try {
    const parsed = JSON.parse(responseText);
    if (parsed?.sha256) actualSha256 = parsed.sha256;
  } catch { /* non-JSON response, keep computed hash */ }

  return {
    metadata: {
      sha256: actualSha256,
      filename,
      size: fileBytes.length,
      mimeType,
      server: blossomServer,
      uploadedAt: Math.floor(Date.now() / 1000),
      uploaderPubkey,
    },
  };
}

export async function download(params: DownloadParams): Promise<Uint8Array> {
  const { metadata, formEditKey, uploaderPubkey } = params;
  const formEditKeyBytes = hexToBytes(formEditKey);
  const authHeader = await createAuthEvent("get", metadata.sha256, formEditKeyBytes);
  const client = new BlossomClient(metadata.server);
  const encryptedBytes = await client.download(metadata.sha256, authHeader);
  const ciphertext = new TextDecoder().decode(encryptedBytes);
  return decryptFileFromUploader(ciphertext, formEditKey, uploaderPubkey);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
