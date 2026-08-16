import { BLOSSOM_AUTH_KIND } from "./constants.js";
import type { BlossomTransport, FileSigner } from "./types.js";
import { bytesToBase64, sha256Hex, throwIfAborted } from "./encoding.js";

function trimServer(server: string): string {
  return server.replace(/\/+$/, "");
}

export function createFetchBlossomTransport(fetchImplementation: typeof fetch = fetch): BlossomTransport {
  return {
    async upload({ server, bytes, authorization, signal, onBytes }) {
      throwIfAborted(signal);
      const response = await fetchImplementation(`${trimServer(server)}/upload`, {
        method: "PUT",
        headers: {
          ...(authorization ? { Authorization: authorization } : {}),
          "Content-Type": "application/octet-stream",
          "X-SHA-256": await sha256Hex(bytes),
        },
        body: bytes as unknown as BodyInit,
        signal,
      });
      if (!response.ok) throw new Error(response.headers.get("X-Reason") || `Blossom upload failed (${response.status})`);
      onBytes?.(bytes.byteLength, bytes.byteLength);
    },
    async download({ server, hash, expectedSize, authorization, signal, onBytes }) {
      throwIfAborted(signal);
      const response = await fetchImplementation(`${trimServer(server)}/${hash}`, {
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
        signal,
      });
      if (!response.ok) throw new Error(response.headers.get("X-Reason") || `Blossom download failed (${response.status})`);
      const contentLength = Number(response.headers.get("content-length"));
      if (expectedSize !== undefined && Number.isFinite(contentLength) && contentLength > expectedSize) {
        await response.body?.cancel();
        throw new Error("Blossom response exceeds expected encrypted file size");
      }
      if (!response.body) return new Uint8Array();

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (expectedSize !== undefined && received > expectedSize) {
          await reader.cancel();
          throw new Error("Blossom response exceeds expected encrypted file size");
        }
        chunks.push(value);
        onBytes?.(received, Number.isFinite(contentLength) && contentLength > 0 ? contentLength : expectedSize ?? received);
      }
      const bytes = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    },
  };
}

export async function createBlossomAuthorization(
  signer: FileSigner,
  verb: "upload" | "get",
  hashes: readonly string[],
  content: string,
  expiresIn: number,
  now: () => number,
): Promise<string> {
  const pubkey = await signer.getPublicKey();
  const createdAt = now();
  const event = await signer.signEvent({
    kind: BLOSSOM_AUTH_KIND,
    created_at: createdAt,
    content,
    tags: [["t", verb], ["expiration", String(createdAt + expiresIn)], ...hashes.map((hash) => ["x", hash])],
  });
  if (event.pubkey !== pubkey) throw new Error("Signer returned an authorization event for a different pubkey");
  return `Nostr ${bytesToBase64(new TextEncoder().encode(JSON.stringify(event)))}`;
}
