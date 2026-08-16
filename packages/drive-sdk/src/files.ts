import { createBlossomAuthorization } from "./blossom.js";
import { METADATA_KIND } from "./constants.js";
import { decryptFileBytes, encryptFile } from "./crypto.js";
import { throwIfAborted } from "./encoding.js";
import { createFileMetadata, createSharedFileMetadata, decryptFileMetadata, decryptFolderMetadata } from "./metadata.js";
import { assertFile, type File, type Folder } from "./schema.js";
import type { DownloadFileContext, EncryptedFile, FileFetchHandle, FetchFilesContext, FetchFoldersContext, FolderEntry, FolderFetchHandle, ShareFileContext, ShareFileResult, UploadBlobContext, UploadFileContext, UploadFileInputs, UploadFileResult } from "./types.js";
import type { Event, Filter } from "nostr-tools";

function emitProgress(
  callback: ((value: import("./types.js").FileProgress) => void) | undefined,
  operation: "upload" | "download",
  completedBytes: number,
  totalBytes: number,
): void {
  callback?.({ operation, completedBytes, totalBytes });
}

interface FetchMetadataContext {
  dataLayer: FetchFilesContext["dataLayer"];
  metadataConversationKey: Uint8Array;
  onEose?: () => void;
  onError?: (error: unknown) => void;
  relayHints?: string[];
}

function fetchMetadata<T, R>(
  filter: Filter,
  subtype: "files" | "folder",
  context: FetchMetadataContext,
  decrypt: (content: string, key: Uint8Array) => T,
  toResult: (value: T, event: Event, d: string) => R,
  onValues: (values: R[]) => void,
): FileFetchHandle {
  const entries = new Map<string, { createdAt: number; eventId: string; value?: R }>();
  const metadataFilter: Filter = { ...filter, kinds: [METADATA_KIND], "#t": [subtype] };
  let stopped = false;
  const emit = () => onValues([...entries.values()]
    .sort((a, b) => b.createdAt - a.createdAt || b.eventId.localeCompare(a.eventId))
    .flatMap((entry) => entry.value === undefined ? [] : [entry.value]));
  const handle = context.dataLayer.observe(
    [metadataFilter],
    {
      onEvent(event) {
        if (stopped) return;
        if (event.kind !== METADATA_KIND || !event.tags.some((tag) => tag[0] === "t" && tag[1] === subtype)) return;
        const d = event.tags.find((tag) => tag[0] === "d")?.[1];
        if (!d) return;
        const key = `${event.pubkey}:${d}`;
        const current = entries.get(key);
        if (current && (current.createdAt > event.created_at || (current.createdAt === event.created_at && current.eventId >= event.id))) return;
        const entry: { createdAt: number; eventId: string; value?: R } = { createdAt: event.created_at, eventId: event.id };
        entries.set(key, entry);
        try {
          entry.value = toResult(decrypt(event.content, context.metadataConversationKey), event, d);
          emit();
        } catch (error) {
          context.onError?.(error);
          emit();
        }
      },
      onEose: () => context.onEose?.(),
    },
    context.relayHints ? { relays: context.relayHints } : undefined,
  );
  return { stop: () => { stopped = true; handle.unobserve(); } };
}

export function fetchFiles(filter: Filter, context: FetchFilesContext): FileFetchHandle {
  return fetchMetadata<File, File>(filter, "files", context, decryptFileMetadata, (file) => file, context.onFiles);
}

export function fetchFolders(filter: Filter, context: FetchFoldersContext): FolderFetchHandle {
  return fetchMetadata<Folder, FolderEntry>(filter, "folder", context, decryptFolderMetadata, (folder, _event, d) => ({ ...folder, id: d }), context.onFolders);
}

export async function uploadEncryptedFile(encryptedFile: EncryptedFile, context: UploadBlobContext): Promise<void> {
  if (context.servers.length === 0) throw new Error("At least one Blossom server is required");
  const totalBytes = encryptedFile.bytes.byteLength * context.servers.length;
  const authorization = context.authorization ?? await createBlossomAuthorization(
    context.signer,
    "upload",
    [encryptedFile.blobHash],
    context.authorizationContent ?? "Upload encrypted file",
    context.authorizationExpiresIn ?? 300,
    context.now ?? (() => Math.floor(Date.now() / 1000)),
  );
  let completedBytes = 0;
  for (const server of context.servers) {
    throwIfAborted(context.signal);
    await context.transport.upload({
      server,
      bytes: encryptedFile.bytes,
      authorization,
      signal: context.signal,
      onBytes: (current) => emitProgress(context.onProgress, "upload", completedBytes + current, totalBytes),
    });
    completedBytes += encryptedFile.bytes.byteLength;
    emitProgress(context.onProgress, "upload", completedBytes, totalBytes);
  }
}

export async function downloadFile(file: File, context: DownloadFileContext): Promise<Blob> {
  assertFile(file);
  const expectedSize = file.size + Math.max(1, Math.ceil(file.size / file.chunkSize)) * 16;
  const authorization = context.authorization
    ?? (context.signer
      ? await createBlossomAuthorization(
        context.signer,
        "get",
        [file.blobHash],
        context.authorizationContent ?? "Download encrypted file",
        context.authorizationExpiresIn ?? 300,
        context.now ?? (() => Math.floor(Date.now() / 1000)),
      )
      : undefined);
  const errors: unknown[] = [];
  for (const server of file.servers) {
    throwIfAborted(context.signal);
    try {
      const bytes = await context.transport.download({
        server,
        hash: file.blobHash,
        expectedSize,
        authorization,
        signal: context.signal,
        onBytes: (current, total) => emitProgress(context.onProgress, "download", current, total),
      });
      const plaintext = await decryptFileBytes(bytes, file);
      emitProgress(context.onProgress, "download", bytes.byteLength, bytes.byteLength);
      return new Blob([new Uint8Array(plaintext)], { type: file.type });
    } catch (error) {
      if (context.signal?.aborted) throw error;
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "Unable to download a valid encrypted file from any Blossom server");
}

export async function uploadFile(
  source: Blob | Uint8Array,
  inputs: UploadFileInputs,
  context: UploadFileContext,
): Promise<UploadFileResult> {
  const encryptedFile = await encryptFile(source, { chunkSize: inputs.chunkSize });
  const metadata = createFileMetadata({
    name: inputs.name,
    type: inputs.type,
    parent: inputs.parent,
    servers: inputs.servers,
    metadataConversationKey: inputs.metadataConversationKey,
    ...(inputs.previewHash ? { previewHash: inputs.previewHash } : {}),
    uploadedAt: inputs.uploadedAt,
    client: inputs.client,
    d: inputs.d,
    createdAt: inputs.createdAt,
    size: encryptedFile.size,
    encryptionKey: encryptedFile.encryptionKey,
    unencryptedFileHash: encryptedFile.unencryptedFileHash,
    blobHash: encryptedFile.blobHash,
    chunkSize: encryptedFile.chunkSize,
  });
  await uploadEncryptedFile(encryptedFile, { ...context, servers: inputs.servers });
  throwIfAborted(context.signal);
  const { event, result: publishResult } = await context.dataLayer.publish(metadata.event);
  if (!publishResult.ok) throw new Error("No relay accepted the file metadata event");
  return { encryptedFile, metadata, event, publishResult };
}

export async function shareFile(file: File, context: ShareFileContext): Promise<ShareFileResult> {
  const { dataLayer, ...options } = context;
  const shared = createSharedFileMetadata(file, options);
  const { event: signedEvent, result: publishResult } = await dataLayer.publish(shared.event);
  if (!publishResult.ok) throw new Error("No relay accepted the shared file metadata event");
  return { ...shared, signedEvent, publishResult };
}
