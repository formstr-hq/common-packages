import { BLOSSOM_AUTH_KIND, type BlossomTransport, type FileSigner } from "./types.js";
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
    async download({ server, hash, authorization, signal, onBytes }) {
      throwIfAborted(signal);
      const response = await fetchImplementation(`${trimServer(server)}/${hash}`, {
        ...(authorization ? { headers: { Authorization: authorization } } : {}),
        signal,
      });
      if (!response.ok) throw new Error(response.headers.get("X-Reason") || `Blossom download failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      onBytes?.(bytes.byteLength, Number(response.headers.get("content-length")) || bytes.byteLength);
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
  const event = await signer.signEvent({
    kind: BLOSSOM_AUTH_KIND,
    created_at: now(),
    content,
    tags: [["t", verb], ["expiration", String(now() + expiresIn)], ...hashes.map((hash) => ["x", hash])],
  });
  if (event.pubkey !== pubkey) throw new Error("Signer returned an authorization event for a different pubkey");
  return `Nostr ${bytesToBase64(new TextEncoder().encode(JSON.stringify(event)))}`;
}
