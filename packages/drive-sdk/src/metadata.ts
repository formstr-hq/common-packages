import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { DRIVE_SDK_CLIENT, METADATA_KIND } from "./constants.js";
import { conversationKeyFromSecret } from "./crypto.js";
import { assertFile, assertFolder, type File, type Folder } from "./schema.js";
import {
  type CreatedFileMetadata,
  type CreatedFolderMetadata,
  type CreatedSharedFileMetadata,
  type FileMetadataInputs,
  type FolderMetadataInputs,
  type SharedFileOptions,
} from "./types.js";

const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomDTag(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (byte) => ALPHANUMERIC[byte % ALPHANUMERIC.length]).join("");
}

interface MetadataEventOptions {
  client?: string;
  d?: string;
  createdAt?: number;
}

function eventTemplate(content: string, subtype: "files" | "folder" | "shared-file", options: MetadataEventOptions): { d: string; event: import("nostr-tools").EventTemplate } {
  const d = options.d ?? randomDTag();
  return {
    d,
    event: {
      kind: METADATA_KIND,
      created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
      tags: [["d", d], ["t", subtype], ["encrypted", "nip44"], ["client", options.client ?? DRIVE_SDK_CLIENT]],
      content,
    },
  };
}

export function createFileMetadata(inputs: FileMetadataInputs): CreatedFileMetadata {
  if (inputs.metadataConversationKey.length !== 32) {
    throw new Error("metadataConversationKey must be 32 bytes");
  }
  const {
    metadataConversationKey,
    d,
    createdAt,
    client,
    uploadedAt = Date.now(),
    ...values
  } = inputs;
  const file: File = { ...values, uploadedAt, encryptionAlgorithm: "aes-gcm" };
  assertFile(file);
  const created = eventTemplate(
    nip44.v2.encrypt(JSON.stringify(file), metadataConversationKey),
    "files",
    { d, createdAt, client },
  );
  return { ...created, file };
}

export function decryptFileMetadata(content: string, metadataConversationKey: Uint8Array): File {
  const value: unknown = JSON.parse(nip44.v2.decrypt(content, metadataConversationKey));
  assertFile(value);
  return value;
}

export function createFolderMetadata(inputs: FolderMetadataInputs): CreatedFolderMetadata {
  if (inputs.metadataConversationKey.length !== 32) {
    throw new Error("metadataConversationKey must be 32 bytes");
  }
  const { metadataConversationKey, d, createdAt, client, ...values } = inputs;
  const folder: Folder = values;
  assertFolder(folder);
  const created = eventTemplate(
    nip44.v2.encrypt(JSON.stringify(folder), metadataConversationKey),
    "folder",
    { d, createdAt, client },
  );
  return { ...created, folder };
}

export function decryptFolderMetadata(content: string, metadataConversationKey: Uint8Array): Folder {
  const value: unknown = JSON.parse(nip44.v2.decrypt(content, metadataConversationKey));
  assertFolder(value);
  return value;
}

export function createSharedFileMetadata(file: File, options: SharedFileOptions = {}): CreatedSharedFileMetadata {
  assertFile(file);
  const secret = generateSecretKey();
  const sharingKey = bytesToHex(secret);
  const publicSharingKey = getPublicKey(secret);
  const content = nip44.v2.encrypt(JSON.stringify(file), conversationKeyFromSecret(sharingKey));
  const created = eventTemplate(content, "shared-file", options);
  return { ...created, file, sharingKey, publicSharingKey };
}

export function decryptSharedFileMetadata(content: string, sharingKey: string): File {
  return decryptFileMetadata(content, conversationKeyFromSecret(sharingKey));
}
