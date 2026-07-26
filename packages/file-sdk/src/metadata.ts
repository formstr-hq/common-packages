import { nip44 } from "nostr-tools";
import { FILE_METADATA_KIND, type ChunkRef, type CreatedFileMetadata, type FileMetadata, type MetadataInputs } from "./types.js";

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomDTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join("");
}

export function createFileMetadata(chunkHashes: readonly (string | ChunkRef)[], inputs: MetadataInputs): CreatedFileMetadata {
  if (!inputs.name || !inputs.server || !inputs.encryptionKey || !inputs.type) {
    throw new Error("name, type, server, and encryptionKey are required metadata inputs");
  }
  if (inputs.metadataConversationKey.length === 0) throw new Error("metadataConversationKey is required");

  const chunks: ChunkRef[] = chunkHashes.map((chunk) => typeof chunk === "string" ? { hash: chunk } : { ...chunk });
  if (chunks.length === 0) throw new Error("At least one encrypted chunk is required");
  if (chunks.some((chunk) => !/^[0-9a-f]{64}$/i.test(chunk.hash))) throw new Error("Chunk hashes must be SHA-256 hex strings");

  const metadata: FileMetadata = {
    name: inputs.name,
    ...(inputs.unencryptedFileHash ? { unencryptedFileHash: inputs.unencryptedFileHash } : {}),
    size: inputs.size,
    type: inputs.type,
    folder: inputs.folder,
    uploadedAt: inputs.uploadedAt ?? Date.now(),
    server: inputs.server,
    encryptionKey: inputs.encryptionKey,
    encryptionAlgorithm: "aes-gcm",
    ...(inputs.previewHash ? { previewHash: inputs.previewHash } : {}),
    chunks,
  };
  const d = inputs.d ?? randomDTag();
  const createdAt = inputs.createdAt ?? Math.floor(Date.now() / 1000);
  const content = nip44.v2.encrypt(JSON.stringify(metadata), inputs.metadataConversationKey);
  return {
    d,
    metadata,
    event: {
      kind: FILE_METADATA_KIND,
      created_at: createdAt,
      tags: [["d", d], ["t", "files"], ["encrypted", "nip44"], ["client", inputs.client ?? "formstr-file-sdk"]],
      content,
    },
  };
}

export function decryptFileMetadata(content: string, metadataConversationKey: Uint8Array): FileMetadata {
  const value: unknown = JSON.parse(nip44.v2.decrypt(content, metadataConversationKey));
  if (!isFileMetadata(value)) throw new Error("Invalid NIP-FS metadata payload");
  return value;
}

export function isFileMetadata(value: unknown): value is FileMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Partial<FileMetadata>;
  return typeof metadata.name === "string"
    && typeof metadata.size === "number"
    && typeof metadata.type === "string"
    && typeof metadata.folder === "string"
    && typeof metadata.uploadedAt === "number"
    && typeof metadata.server === "string"
    && typeof metadata.encryptionKey === "string"
    && /^[0-9a-f]{64}$/i.test(metadata.encryptionKey)
    && metadata.encryptionAlgorithm === "aes-gcm"
    && Array.isArray(metadata.chunks)
    && metadata.chunks.length > 0
    && metadata.chunks.every((chunk) => chunk && typeof chunk.hash === "string" && /^[0-9a-f]{64}$/i.test(chunk.hash));
}
