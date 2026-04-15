// kind 24242 auth events (BUD-11)

import { finalizeEvent, getPublicKey } from "nostr-tools";
import type { AuthVerb } from "./types.js";

export async function createAuthEvent(
  verb: AuthVerb,
  sha256: string,
  secretKey: Uint8Array,
  expirationSeconds = 60,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  const tags: string[][] = [
    ["t", verb],
    ["expiration", String(now + expirationSeconds)],
  ];

  let content: string;
  if (verb === "upload") content = "Upload blob";
  else if (verb === "delete") content = "Delete blob";
  else content = sha256;

  if (verb === "upload" || verb === "delete") {
    tags.push(["x", sha256]);
  }

  const pubkey = getPublicKey(secretKey);
  const event = { kind: 24242, pubkey, content, created_at: now, tags };
  const signedEvent = finalizeEvent(event, secretKey);

  const json = JSON.stringify(signedEvent);
  const b64 = typeof btoa !== "undefined"
    ? btoa(json)
    : Buffer.from(json, "utf-8").toString("base64");
  return `Nostr ${b64}`;
}
