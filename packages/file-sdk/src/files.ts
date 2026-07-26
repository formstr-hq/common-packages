import { createBlossomAuthorization } from "./blossom.js";
import { decryptNipFsChunk, encryptFile } from "./crypto.js";
import { sha256Hex, throwIfAborted } from "./encoding.js";
import { createFileMetadata, decryptFileMetadata } from "./metadata.js";
import { FILE_METADATA_KIND, type DownloadFileContext, type FileFetchHandle, type FileMetadata, type FetchFilesContext, type MetadataInputs, type UploadChunksContext, type UploadFileContext, type UploadFileResult } from "./types.js";
import type { Filter } from "nostr-tools";

function emitProgress(
  callback: ((value: import("./types.js").FileProgress) => void) | undefined,
  operation: "upload" | "download",
  completedChunks: number,
  totalChunks: number,
  completedBytes: number,
  totalBytes: number,
): void {
  callback?.({ operation, completedChunks, totalChunks, completedBytes, totalBytes });
}

export function fetchFiles(filter: Filter, context: FetchFilesContext): FileFetchHandle {
  const entries = new Map<string, { createdAt: number; metadata: FileMetadata }>();
  const fileFilter: Filter = { ...filter, kinds: [FILE_METADATA_KIND], "#t": ["files"] };
  let stopped = false;
  const emit = () => context.onFiles([...entries.values()].sort((a, b) => b.createdAt - a.createdAt).map((entry) => entry.metadata));
  const handle = context.dataLayer.observe(
    [fileFilter],
    {
      onEvent(event) {
        if (stopped) return;
        try {
          const d = event.tags.find((tag) => tag[0] === "d")?.[1];
          if (!d) return;
          const current = entries.get(d);
          if (current && current.createdAt >= event.created_at) return;
          entries.set(d, { createdAt: event.created_at, metadata: decryptFileMetadata(event.content, context.metadataConversationKey) });
          emit();
        } catch (error) {
          context.onError?.(error);
        }
      },
      onEose: () => context.onEose?.(),
    },
    context.relayHints ? { relays: context.relayHints } : undefined,
  );
  return { stop: () => { stopped = true; handle.unobserve(); } };
}

export async function uploadChunks(chunks: readonly import("./types.js").EncryptedChunk[], context: UploadChunksContext): Promise<void> {
  if (chunks.length === 0) throw new Error("At least one encrypted chunk is required");
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0);
  const authorization = context.authorization ?? await createBlossomAuthorization(
    context.signer,
    "upload",
    chunks.map((chunk) => chunk.hash),
    context.authorizationContent ?? "Upload encrypted file chunks",
    context.authorizationExpiresIn ?? 300,
    context.now ?? (() => Math.floor(Date.now() / 1000)),
  );
  let completedBytes = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    throwIfAborted(context.signal);
    const chunk = chunks[index];
    await context.transport.upload({
      server: context.server,
      bytes: chunk.bytes,
      authorization,
      signal: context.signal,
      onBytes: (current) => emitProgress(context.onProgress, "upload", index, chunks.length, completedBytes + current, totalBytes),
    });
    completedBytes += chunk.bytes.byteLength;
    emitProgress(context.onProgress, "upload", index + 1, chunks.length, completedBytes, totalBytes);
  }
}

export async function downloadFile(metadata: FileMetadata, context: DownloadFileContext): Promise<Blob> {
  const chunks = metadata.chunks;
  if (chunks.length === 0) throw new Error("File metadata does not contain any chunks");
  const authorization = context.authorization
    ?? (context.signer
      ? await createBlossomAuthorization(
        context.signer,
        "get",
        chunks.map((chunk) => chunk.hash),
        context.authorizationContent ?? "Download encrypted file chunks",
        context.authorizationExpiresIn ?? 300,
        context.now ?? (() => Math.floor(Date.now() / 1000)),
      )
      : undefined);
  const decrypted: Uint8Array[] = [];
  let completedBytes = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    throwIfAborted(context.signal);
    const chunk = chunks[index];
    const bytes = await context.transport.download({
      server: chunk.server ?? metadata.server,
      hash: chunk.hash,
      authorization,
      signal: context.signal,
      onBytes: (current) => emitProgress(context.onProgress, "download", index, chunks.length, completedBytes + current, metadata.size),
    });
    const plaintext = await decryptNipFsChunk(bytes, metadata.encryptionKey);
    decrypted.push(plaintext);
    completedBytes += plaintext.byteLength;
    emitProgress(context.onProgress, "download", index + 1, chunks.length, completedBytes, metadata.size);
  }
  const complete = new Uint8Array(completedBytes);
  let offset = 0;
  for (const bytes of decrypted) {
    complete.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (metadata.unencryptedFileHash && await sha256Hex(complete) !== metadata.unencryptedFileHash.toLowerCase()) {
    throw new Error("Downloaded file hash does not match file metadata");
  }
  if (complete.byteLength !== metadata.size) throw new Error("Downloaded file size does not match file metadata");
  return new Blob([complete], { type: metadata.type });
}

export async function uploadFile(
  fileBlob: Blob,
  chunkSize: number,
  inputs: Omit<MetadataInputs, "size" | "encryptionKey" | "unencryptedFileHash">,
  context: UploadFileContext,
): Promise<UploadFileResult> {
  const encryptedFile = await encryptFile(fileBlob, chunkSize);
  await uploadChunks(encryptedFile.chunks, { ...context, server: inputs.server });
  throwIfAborted(context.signal);
  const metadata = createFileMetadata(encryptedFile.chunks.map((chunk) => chunk.hash), {
    ...inputs,
    size: encryptedFile.size,
    encryptionKey: encryptedFile.encryptionKey,
    unencryptedFileHash: encryptedFile.unencryptedFileHash,
  });
  const { event, result: publishResult } = await context.dataLayer.publish(metadata.event);
  if (!publishResult.ok) throw new Error("No relay accepted the file metadata event");
  return { encryptedFile, metadata, event, publishResult };
}
