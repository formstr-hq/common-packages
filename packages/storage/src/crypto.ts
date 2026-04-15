// nip-44 v2 for large payloads (HKDF + AES-GCM)

import { nip44, getPublicKey } from "nostr-tools";

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return typeof btoa !== "undefined"
    ? btoa(binary)
    : Buffer.from(binary, "binary").toString("base64");
}

export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = typeof atob !== "undefined"
    ? atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function nip44EncryptLarge(plaintext: string, conversationKey: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const plaintextBytes = encoder.encode(plaintext);
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const info = encoder.encode("nip44-v2");

  const baseKey = await crypto.subtle.importKey("raw", conversationKey as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce, info }, baseKey, 44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey("raw", derived.slice(0, 32), "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: derived.slice(32, 44) }, aesKey, plaintextBytes),
  );

  const payload = new Uint8Array(1 + 32 + ciphertext.length);
  payload[0] = 2;
  payload.set(nonce, 1);
  payload.set(ciphertext, 33);
  return uint8ArrayToBase64(payload);
}

async function nip44DecryptLarge(ciphertext: string, conversationKey: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const payload = base64ToUint8Array(ciphertext);
  if (payload[0] !== 2) throw new Error(`Unsupported NIP-44 version: ${payload[0]}`);

  const nonce = payload.slice(1, 33);
  const ciphertextBytes = payload.slice(33);

  const baseKey = await crypto.subtle.importKey("raw", conversationKey as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const derivedBits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: nonce, info: encoder.encode("nip44-v2") },
    baseKey, 44 * 8,
  );
  const derived = new Uint8Array(derivedBits);
  const aesKey = await crypto.subtle.importKey("raw", derived.slice(0, 32), "AES-GCM", false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: derived.slice(32, 44) }, aesKey, ciphertextBytes,
  );
  return decoder.decode(plaintext);
}

export async function encryptFileToAuthor(
  fileBytes: Uint8Array,
  formAuthorPubkey: string,
  responderSecretKey: Uint8Array,
): Promise<{ ciphertext: string; uploaderPubkey: string }> {
  const uploaderPubkey = getPublicKey(responderSecretKey);
  const plaintextBase64 = uint8ArrayToBase64(fileBytes);
  const conversationKey = nip44.v2.utils.getConversationKey(responderSecretKey, formAuthorPubkey);
  const ciphertext = await nip44EncryptLarge(plaintextBase64, conversationKey);
  return { ciphertext, uploaderPubkey };
}

export async function decryptFileFromUploader(
  ciphertext: string,
  formEditKey: string,
  uploaderPubkey: string,
): Promise<Uint8Array> {
  const formEditKeyBytes = hexToBytes(formEditKey);
  const conversationKey = nip44.v2.utils.getConversationKey(formEditKeyBytes, uploaderPubkey);
  const plaintextBase64 = await nip44DecryptLarge(ciphertext, conversationKey);
  return base64ToUint8Array(plaintextBase64);
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export async function calculateSHA256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}
