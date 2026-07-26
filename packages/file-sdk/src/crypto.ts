import { generateSecretKey, getPublicKey, nip44 } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { base64ToBytes, bytesToBase64, bytesToUtf8, sha256Hex, utf8ToBytes } from "./encoding.js";
import type { EncryptedChunk, EncryptedFile } from "./types.js";

const NIP_FS_VERSION = 0x02;
const NONCE_BYTES = 32;
const HKDF_INFO = new TextEncoder().encode("nip44-v2");

function assertChunkSize(chunkSize: number): void {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive safe integer");
  }
}

function conversationKeyFromSecret(secretHex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) throw new Error("encryptionKey must be a 32-byte hex private key");
  const secret = hexToBytes(secretHex);
  return nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
}

async function deriveAesGcmKey(conversationKey: Uint8Array, nonce: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey("raw", conversationKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce as BufferSource, info: HKDF_INFO },
    baseKey,
    44 * 8,
  );
  return crypto.subtle.importKey("raw", new Uint8Array(bits).slice(0, 32) as BufferSource, "AES-GCM", false, usage);
}

async function deriveIv(conversationKey: Uint8Array, nonce: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey("raw", conversationKey as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce as BufferSource, info: HKDF_INFO },
    baseKey,
    44 * 8,
  );
  return new Uint8Array(bits).slice(32, 44);
}

async function encryptChunk(plaintext: Uint8Array, conversationKey: Uint8Array): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const [key, iv] = await Promise.all([
    deriveAesGcmKey(conversationKey, nonce, ["encrypt"]),
    deriveIv(conversationKey, nonce),
  ]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, utf8ToBytes(bytesToBase64(plaintext)) as BufferSource);
  const envelope = new Uint8Array(1 + NONCE_BYTES + ciphertext.byteLength);
  envelope[0] = NIP_FS_VERSION;
  envelope.set(nonce, 1);
  envelope.set(new Uint8Array(ciphertext), 1 + NONCE_BYTES);
  return utf8ToBytes(bytesToBase64(envelope));
}

export async function decryptNipFsChunk(blob: Uint8Array, encryptionKey: string): Promise<Uint8Array> {
  const encodedEnvelope = bytesToUtf8(blob);
  const envelope = base64ToBytes(encodedEnvelope);
  if (envelope.length <= 1 + NONCE_BYTES || envelope[0] !== NIP_FS_VERSION) {
    throw new Error("Invalid NIP-FS encrypted chunk");
  }
  const nonce = envelope.slice(1, 1 + NONCE_BYTES);
  const conversationKey = conversationKeyFromSecret(encryptionKey);
  const [key, iv] = await Promise.all([
    deriveAesGcmKey(conversationKey, nonce, ["decrypt"]),
    deriveIv(conversationKey, nonce),
  ]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    envelope.slice(1 + NONCE_BYTES) as BufferSource,
  );
  return base64ToBytes(bytesToUtf8(new Uint8Array(plaintext)));
}

export async function encryptFile(fileBlob: Blob, chunkSize: number): Promise<EncryptedFile> {
  assertChunkSize(chunkSize);
  const source = new Uint8Array(await fileBlob.arrayBuffer());
  const secret = generateSecretKey();
  const encryptionKey = bytesToHex(secret);
  const conversationKey = nip44.v2.utils.getConversationKey(secret, getPublicKey(secret));
  const totalChunks = Math.max(1, Math.ceil(source.byteLength / chunkSize));
  const chunks: EncryptedChunk[] = [];

  for (let index = 0; index < totalChunks; index += 1) {
    const plaintext = source.slice(index * chunkSize, Math.min(source.byteLength, (index + 1) * chunkSize));
    const bytes = await encryptChunk(plaintext, conversationKey);
    chunks.push({ bytes, hash: await sha256Hex(bytes) });
  }

  return { chunks, encryptionKey, unencryptedFileHash: await sha256Hex(source), size: source.byteLength };
}
