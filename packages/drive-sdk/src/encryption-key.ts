import { generateSecretKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { DRIVE_SDK_CLIENT, METADATA_KIND } from "./constants.js";
import { conversationKeyFromSecret } from "./crypto.js";
import { assertEncryptionKeyMetadata } from "./schema.js";
import type {
  FetchEncryptionKeyContext,
  FetchedEncryptionKey,
  UpdateEncryptionKeyContext,
  UpdatedEncryptionKey,
  UpdateEncryptionKeyOptions,
} from "./types.js";

let lastGeneratedCreatedAt = 0;

export function deriveMetadataConversationKey(encryptionKey: string): Uint8Array {
  assertEncryptionKeyMetadata({ encryptionKey });
  return conversationKeyFromSecret(encryptionKey);
}

export async function fetchEncryptionKey(context: FetchEncryptionKeyContext): Promise<FetchedEncryptionKey | null> {
  const pubkey = await context.signer.getPublicKey();
  const d = `0:${pubkey}`;

  return new Promise((resolve, reject) => {
    let latest: import("nostr-tools").Event | undefined;
    let handle: { unobserve(): void } | undefined;
    let settled = false;

    const cleanup = () => {
      handle?.unobserve();
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    };
    const finish = async (event: import("nostr-tools").Event | undefined) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!event) {
        resolve(null);
        return;
      }
      try {
        const plaintext = await context.signer.nip44Decrypt(pubkey, event.content);
        const metadata: unknown = JSON.parse(plaintext);
        assertEncryptionKeyMetadata(metadata);
        resolve({
          encryptionKey: metadata.encryptionKey,
          metadataConversationKey: deriveMetadataConversationKey(metadata.encryptionKey),
          event,
        });
      } catch (error) {
        reject(error);
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("Operation aborted", "AbortError"));
    };
    const timer = setTimeout(() => void finish(latest), context.timeoutMs ?? 10_000);
    context.signal?.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted) {
      onAbort();
      return;
    }

    handle = context.dataLayer.observe(
      [{ kinds: [METADATA_KIND], authors: [pubkey], "#d": [d] }],
      {
        onEvent(event) {
          if (event.kind !== METADATA_KIND || event.pubkey !== pubkey || !event.tags.some((tag) => tag[0] === "d" && tag[1] === d)) return;
          if (!latest || event.created_at > latest.created_at || (event.created_at === latest.created_at && event.id > latest.id)) {
            latest = event;
          }
        },
        onEose() {
          if (context.localOnly) void finish(latest);
        },
      },
      {
        ...(context.relayHints ? { relays: context.relayHints } : {}),
        ...(context.localOnly !== undefined ? { localOnly: context.localOnly } : {}),
      },
    );
    if (settled) handle.unobserve();
  });
}

export async function updateEncryptionKey(
  context: UpdateEncryptionKeyContext,
  options: UpdateEncryptionKeyOptions = {},
): Promise<UpdatedEncryptionKey> {
  const pubkey = await context.signer.getPublicKey();
  const encryptionKey = options.encryptionKey ?? bytesToHex(generateSecretKey());
  assertEncryptionKeyMetadata({ encryptionKey });
  const content = await context.signer.nip44Encrypt(pubkey, JSON.stringify({ encryptionKey }));
  const createdAt = options.createdAt ?? Math.max(Math.floor(Date.now() / 1000), lastGeneratedCreatedAt + 1);
  if (options.createdAt === undefined) lastGeneratedCreatedAt = createdAt;
  const { event, result: publishResult } = await context.dataLayer.publish({
    kind: METADATA_KIND,
    created_at: createdAt,
    tags: [["d", `0:${pubkey}`], ["client", options.client ?? DRIVE_SDK_CLIENT]],
    content,
  });
  if (event.pubkey !== pubkey) throw new Error("Published encryption key metadata for a different pubkey");
  if (!publishResult.ok) throw new Error("No relay accepted the encryption key metadata event");
  return {
    encryptionKey,
    metadataConversationKey: deriveMetadataConversationKey(encryptionKey),
    event,
    publishResult,
  };
}
