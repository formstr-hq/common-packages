import { EventTemplate, getEventHash, Event, nip19 } from "nostr-tools";
import { NostrSigner } from "./types";
import { NPub } from "nostr-tools/nip19";

export function createNIP55Signer(
  packageName: string,
  initialPubkey?: string,
): NostrSigner {
  let cachedPubkey: string | undefined = initialPubkey;
  let packageNameSet = false;

  const getPlugin = async () => {
    const { NostrSignerPlugin } = await import("nostr-signer-capacitor-plugin");
    return NostrSignerPlugin;
  };

  const ensurePackageNameSet = async () => {
    if (!packageNameSet) {
      const plugin = await getPlugin();
      await plugin.setPackageName(packageName);
      packageNameSet = true;
    }
  };

  return {
    async getPublicKey(): Promise<string> {
      if (cachedPubkey) {
        await ensurePackageNameSet();
        return cachedPubkey;
      }

      await ensurePackageNameSet();

      const plugin = await getPlugin();
      const { npub } = await plugin.getPublicKey();
      cachedPubkey = nip19.decode(npub as NPub).data as string;
      return cachedPubkey;
    },

    async signEvent(event: EventTemplate): Promise<Event> {
      const pubkey = await this.getPublicKey();

      const fullEvent = { ...event, pubkey };
      const id = getEventHash(fullEvent);
      const eventWithId = { ...fullEvent, id };

      const plugin = await getPlugin();
      const { event: signedEventJson } = await plugin.signEvent(
        packageName,
        JSON.stringify(eventWithId),
        eventWithId.id,
        pubkey,
      );

      if (!signedEventJson) {
        throw new Error("Signer did not return a signed event");
      }

      return JSON.parse(signedEventJson) as Event;
    },

    async encrypt(pubkey: string, plaintext: string): Promise<string> {
      const currentPubkey = await this.getPublicKey();

      const plugin = await getPlugin();
      const { result } = await plugin.nip04Encrypt(
        packageName,
        plaintext,
        "",
        pubkey,
        currentPubkey,
      );

      if (!result) throw new Error("NIP-04 encryption failed");

      return result;
    },

    async decrypt(pubkey: string, ciphertext: string): Promise<string> {
      const currentPubkey = await this.getPublicKey();

      const plugin = await getPlugin();
      const { result } = await plugin.nip04Decrypt(
        packageName,
        ciphertext,
        "",
        pubkey,
        currentPubkey,
      );

      if (!result) throw new Error("NIP-04 decryption failed");

      return result;
    },

    async nip44Encrypt(pubkey: string, plaintext: string): Promise<string> {
      const currentPubkey = await this.getPublicKey();

      const plugin = await getPlugin();
      const { result } = await plugin.nip44Encrypt(
        packageName,
        plaintext,
        "",
        pubkey,
        currentPubkey,
      );

      if (!result) throw new Error("NIP-44 encryption failed");

      return result;
    },

    async nip44Decrypt(pubkey: string, ciphertext: string): Promise<string> {
      const currentPubkey = await this.getPublicKey();

      const plugin = await getPlugin();
      const { result } = await plugin.nip44Decrypt(
        packageName,
        ciphertext,
        "",
        pubkey,
        currentPubkey,
      );

      if (!result) throw new Error("NIP-44 decryption failed");

      return result;
    },
  };
}
