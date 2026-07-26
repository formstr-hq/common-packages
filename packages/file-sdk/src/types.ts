import type { Event, EventTemplate, Filter } from "nostr-tools";

export const FILE_METADATA_KIND = 34578;
export const BLOSSOM_AUTH_KIND = 24242;

export interface ChunkRef {
  hash: string;
  server?: string;
}

export interface FileMetadata {
  name: string;
  unencryptedFileHash?: string;
  size: number;
  type: string;
  folder: string;
  uploadedAt: number;
  server: string;
  encryptionKey: string;
  encryptionAlgorithm: "aes-gcm";
  previewHash?: string;
  chunks: ChunkRef[];
}

export interface EncryptedChunk {
  hash: string;
  bytes: Uint8Array;
}

export interface EncryptedFile {
  chunks: EncryptedChunk[];
  encryptionKey: string;
  unencryptedFileHash: string;
  size: number;
}

export interface FileSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<Event>;
}

/** Structural subset of @formstr/local-relay's DataLayer used by this package. */
export interface FileEventStore {
  observe(
    filters: Filter[],
    handlers: { onEvent(event: Event): void; onEose?(): void },
    options?: { localOnly?: boolean; relays?: string[] },
  ): { unobserve(): void };
  publish(template: EventTemplate): Promise<{ event: Event; result: FilePublishResult }>;
}

export interface FilePublishResult {
  ok: boolean;
  accepted: number;
  total: number;
  relayResults: unknown[];
}

export interface FileProgress {
  operation: "upload" | "download";
  completedChunks: number;
  totalChunks: number;
  completedBytes: number;
  totalBytes: number;
}

export interface BlossomTransport {
  upload(input: {
    server: string;
    bytes: Uint8Array;
    authorization?: string;
    signal?: AbortSignal;
    onBytes?: (completedBytes: number, totalBytes: number) => void;
  }): Promise<void>;
  download(input: {
    server: string;
    hash: string;
    authorization?: string;
    signal?: AbortSignal;
    onBytes?: (completedBytes: number, totalBytes: number) => void;
  }): Promise<Uint8Array>;
}

export interface FetchFilesContext {
  dataLayer: FileEventStore;
  metadataConversationKey: Uint8Array;
  onFiles: (files: FileMetadata[]) => void;
  onEose?: () => void;
  onError?: (error: unknown) => void;
  relayHints?: string[];
}

export interface FileFetchHandle {
  stop(): void;
}

export interface DownloadFileContext {
  transport: BlossomTransport;
  /** Used to construct BUD-01 GET authorization when the server requires it. */
  signer?: FileSigner;
  authorization?: string;
  authorizationContent?: string;
  authorizationExpiresIn?: number;
  now?: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: FileProgress) => void;
}

export interface UploadChunksContext {
  signer: FileSigner;
  transport: BlossomTransport;
  server: string;
  signal?: AbortSignal;
  onProgress?: (progress: FileProgress) => void;
  authorization?: string;
  authorizationContent?: string;
  authorizationExpiresIn?: number;
  now?: () => number;
}

export interface MetadataInputs {
  name: string;
  size: number;
  type: string;
  folder: string;
  server: string;
  encryptionKey: string;
  metadataConversationKey: Uint8Array;
  unencryptedFileHash?: string;
  previewHash?: string;
  uploadedAt?: number;
  client?: string;
  d?: string;
  createdAt?: number;
}

export interface CreatedFileMetadata {
  d: string;
  metadata: FileMetadata;
  event: EventTemplate;
}

export interface UploadFileContext extends Omit<UploadChunksContext, "server"> {
  dataLayer: FileEventStore;
}

export interface UploadFileResult {
  encryptedFile: EncryptedFile;
  metadata: CreatedFileMetadata;
  event: Event;
  publishResult: FilePublishResult;
}
