import { generateSecretKey, getPublicKey, nip44, type Event, type EventTemplate } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
  createFileMetadata,
  decryptFileMetadata,
  decryptNipFsChunk,
  downloadFile,
  encryptFile,
  fetchFiles,
  uploadChunks,
  uploadFile,
  type BlossomTransport,
  type FileEventStore,
  type FileSigner,
} from "./index.js";

const pubkey = "a".repeat(64);
const signature = "b".repeat(128);

function metadataKey(): Uint8Array {
  const secret = generateSecretKey();
  return nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
}

function event(template: EventTemplate, id = "c".repeat(64)): Event {
  return { ...template, id, pubkey, sig: signature };
}

function signer(): FileSigner {
  return { getPublicKey: async () => pubkey, signEvent: async (template) => event(template) };
}

function memoryTransport(): { transport: BlossomTransport; blobs: Map<string, Uint8Array>; authorizations: string[] } {
  const blobs = new Map<string, Uint8Array>();
  const authorizations: string[] = [];
  return {
    blobs,
    authorizations,
    transport: {
      upload: async ({ bytes, authorization, onBytes }) => {
        const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
        const key = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
        blobs.set(key, bytes);
        authorizations.push(authorization);
        onBytes?.(bytes.byteLength, bytes.byteLength);
      },
      download: async ({ hash, onBytes }) => {
        const bytes = blobs.get(hash);
        if (!bytes) throw new Error("missing blob");
        onBytes?.(bytes.byteLength, bytes.byteLength);
        return bytes;
      },
    },
  };
}

function memoryStore(): { store: FileEventStore; published: EventTemplate[]; emit(event: Event): void; eose(): void } {
  let handlers: { onEvent(event: Event): void; onEose?(): void } | undefined;
  const published: EventTemplate[] = [];
  return {
    published,
    store: {
      observe: (_filters, next) => {
        handlers = next;
        return { unobserve: () => { handlers = undefined; } };
      },
      publish: async (template) => {
        published.push(template);
        return { event: event(template, "d".repeat(64)), result: { ok: true, accepted: 1, total: 1, relayResults: [] } };
      },
    },
    emit: (next) => handlers?.onEvent(next),
    eose: () => handlers?.onEose?.(),
  };
}

describe("@formstr/file-sdk", () => {
  it("encrypts and decrypts single and multiple NIP-FS chunks", async () => {
    const original = new Blob(["hello encrypted NIP-FS world"]);
    const encrypted = await encryptFile(original, 8);

    expect(encrypted.chunks).toHaveLength(4);
    expect(encrypted.chunks.map((chunk) => chunk.hash)).toEqual(expect.arrayContaining(encrypted.chunks.map((chunk) => expect.stringMatching(/^[0-9a-f]{64}$/))));
    expect(new Set(encrypted.chunks.map((chunk) => new TextDecoder().decode(chunk.bytes))).size).toBe(encrypted.chunks.length);

    const decrypted = await Promise.all(encrypted.chunks.map((chunk) => decryptNipFsChunk(chunk.bytes, encrypted.encryptionKey)));
    expect(await new Blob(decrypted).text()).toBe("hello encrypted NIP-FS world");
  });

  it("creates a NIP-FS metadata event encrypted with the supplied drive key", () => {
    const key = metadataKey();
    const created = createFileMetadata(["1".repeat(64)], {
      name: "report.pdf",
      size: 42,
      type: "application/pdf",
      folder: "/work",
      server: "https://blossom.example",
      encryptionKey: "2".repeat(64),
      unencryptedFileHash: "3".repeat(64),
      metadataConversationKey: key,
      d: "file1234",
      createdAt: 123,
      uploadedAt: 456,
      client: "test-client",
    });

    expect(created.event).toMatchObject({ kind: 34578, created_at: 123 });
    expect(created.event.tags).toEqual([["d", "file1234"], ["t", "files"], ["encrypted", "nip44"], ["client", "test-client"]]);
    expect(decryptFileMetadata(created.event.content, key)).toMatchObject({ name: "report.pdf", chunks: [{ hash: "1".repeat(64) }] });
  });

  it("fetches newest decryptable file metadata per d tag and skips invalid events", () => {
    const key = metadataKey();
    const store = memoryStore();
    const received: string[][] = [];
    const handle = fetchFiles({ authors: [pubkey] }, { dataLayer: store.store, metadataConversationKey: key, onFiles: (files) => received.push(files.map((file) => file.name)) });
    const older = createFileMetadata(["4".repeat(64)], { name: "old", size: 1, type: "text/plain", folder: "/", server: "https://s", encryptionKey: "5".repeat(64), metadataConversationKey: key, d: "same", createdAt: 10 });
    const newer = createFileMetadata(["6".repeat(64)], { name: "new", size: 1, type: "text/plain", folder: "/", server: "https://s", encryptionKey: "7".repeat(64), metadataConversationKey: key, d: "same", createdAt: 20 });
    store.emit(event(older.event, "1".repeat(64)));
    store.emit({ ...event(newer.event, "2".repeat(64)), created_at: 20 });
    store.emit({ ...event(newer.event, "3".repeat(64)), id: "3".repeat(64), content: "invalid" });
    expect(received.at(-1)).toEqual(["new"]);
    handle.stop();
  });

  it("uploads chunks with one Blossom authorization and reports progress", async () => {
    const encrypted = await encryptFile(new Blob(["upload test"]), 5);
    const { transport, authorizations } = memoryTransport();
    const updates: number[] = [];
    await uploadChunks(encrypted.chunks, { signer: signer(), transport, server: "https://blossom.example", now: () => 100, onProgress: (progress) => updates.push(progress.completedChunks) });
    expect(authorizations).toHaveLength(encrypted.chunks.length);
    expect(new Set(authorizations).size).toBe(1);
    expect(updates.at(-1)).toBe(encrypted.chunks.length);
  });

  it("stops an upload when the supplied abort signal is already aborted", async () => {
    const encrypted = await encryptFile(new Blob(["cancel upload"]), 5);
    const { transport } = memoryTransport();
    const controller = new AbortController();
    controller.abort();
    await expect(uploadChunks(encrypted.chunks, {
      signer: signer(), transport, server: "https://blossom.example", signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("downloads, verifies, and returns the original file", async () => {
    const original = new Blob(["download test"]);
    const encrypted = await encryptFile(original, 4);
    const { transport } = memoryTransport();
    await uploadChunks(encrypted.chunks, { signer: signer(), transport, server: "https://blossom.example" });
    const blob = await downloadFile({
      name: "download.txt",
      size: encrypted.size,
      type: "text/plain",
      folder: "/",
      uploadedAt: 0,
      server: "https://blossom.example",
      encryptionKey: encrypted.encryptionKey,
      encryptionAlgorithm: "aes-gcm",
      unencryptedFileHash: encrypted.unencryptedFileHash,
      chunks: encrypted.chunks.map((chunk) => ({ hash: chunk.hash })),
    }, { transport });
    expect(await blob.text()).toBe("download test");
  });

  it("constructs optional Blossom GET authorization for protected downloads", async () => {
    const encrypted = await encryptFile(new Blob(["protected download"]), 50);
    const { transport } = memoryTransport();
    await uploadChunks(encrypted.chunks, { signer: signer(), transport, server: "https://blossom.example" });
    const authorizations: string[] = [];
    const protectedTransport: BlossomTransport = {
      ...transport,
      download: async (input) => {
        authorizations.push(input.authorization ?? "");
        return transport.download(input);
      },
    };
    await downloadFile({
      name: "protected.txt", size: encrypted.size, type: "text/plain", folder: "/", uploadedAt: 0, server: "https://blossom.example",
      encryptionKey: encrypted.encryptionKey, encryptionAlgorithm: "aes-gcm", chunks: encrypted.chunks.map((chunk) => ({ hash: chunk.hash })),
    }, { transport: protectedTransport, signer: signer(), now: () => 100 });
    const event = JSON.parse(atob(authorizations[0].replace("Nostr ", "")));
    expect(event.tags).toContainEqual(["t", "get"]);
  });

  it("rejects a downloaded file whose original hash does not match", async () => {
    const encrypted = await encryptFile(new Blob(["hash mismatch"]), 20);
    const { transport } = memoryTransport();
    await uploadChunks(encrypted.chunks, { signer: signer(), transport, server: "https://blossom.example" });
    await expect(downloadFile({
      name: "mismatch.txt", size: encrypted.size, type: "text/plain", folder: "/", uploadedAt: 0, server: "https://blossom.example",
      encryptionKey: encrypted.encryptionKey, encryptionAlgorithm: "aes-gcm", unencryptedFileHash: "0".repeat(64), chunks: encrypted.chunks.map((chunk) => ({ hash: chunk.hash })),
    }, { transport })).rejects.toThrow("hash does not match");
  });

  it("composes encryption, upload, metadata creation, signing, and local-relay publication", async () => {
    const { transport } = memoryTransport();
    const store = memoryStore();
    const result = await uploadFile(new Blob(["complete upload"]), 5, {
      name: "complete.txt", type: "text/plain", folder: "/docs", server: "https://blossom.example", metadataConversationKey: metadataKey(),
    }, { dataLayer: store.store, signer: signer(), transport });
    expect(result.publishResult.ok).toBe(true);
    expect(store.published).toHaveLength(1);
    expect(store.published[0].kind).toBe(34578);
    expect(result.metadata.metadata.name).toBe("complete.txt");
  });
});
