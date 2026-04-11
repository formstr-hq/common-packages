import { EventTemplate, UnsignedEvent } from "nostr-tools";
import {
  BunkerSignerParams,
  BunkerPointer,
  parseBunkerInput,
} from "./nip46";
import { NostrSigner } from "./types";
import { getAppSecretKeyFromLocalStorage } from "./utils";
import { BunkerSigner } from "./nip46";

export async function createNip46Signer(
  uri: string,
  params: BunkerSignerParams = {},
): Promise<NostrSigner> {
  const clientSecretKey: Uint8Array = getAppSecretKeyFromLocalStorage();
  
  if (uri.startsWith("bunker://")) {
    const bp: BunkerPointer | null = await parseBunkerInput(uri);
    if (!bp) throw new Error("Invalid NIP-46 URI");
    const bunker = BunkerSigner.fromBunker(clientSecretKey, bp, params);
    await bunker.connect();
    return wrapBunkerSigner(bunker);
  } else if (uri.startsWith("nostrconnect://")) {
    const bunker = await BunkerSigner.fromURI(clientSecretKey, uri, params);
    return wrapBunkerSigner(bunker);
  } else if (uri.includes("@")) {
    // Handle name@domain.com
    const bp = await parseBunkerInput(uri);
    if (!bp) throw new Error("Failed to find bunker provider for this ID");
    const bunker = BunkerSigner.fromBunker(clientSecretKey, bp, params);
    await bunker.connect();
    return wrapBunkerSigner(bunker);
  } else {
    throw new Error(`Unsupported NIP-46 format: ${uri}`);
  }
}

const wrapBunkerSigner = (bunker: BunkerSigner): NostrSigner => {
  return {
    getPublicKey: async () => await bunker.getPublicKey(),
    signEvent: async (event: EventTemplate) => {
      return bunker.signEvent(event as UnsignedEvent);
    },
    encrypt: async (pubkey: string, plaintext: string) =>
      bunker.nip04Encrypt(pubkey, plaintext),
    decrypt: async (pubkey: string, ciphertext: string) =>
      bunker.nip04Decrypt(pubkey, ciphertext),
    nip44Encrypt: async (pubkey: string, txt: string) =>
      bunker.nip44Encrypt(pubkey, txt),
    nip44Decrypt: async (pubkey: string, ct: string) =>
      bunker.nip44Decrypt(pubkey, ct),
    getRelays: async () => bunker.bp?.relays ?? [],
  };
};
