import { EventTemplate, NostrEvent, VerifiedEvent } from "nostr-tools";
import {
  generateSecretKey,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  SimplePool,
} from "nostr-tools";
import { AbstractSimplePool, SubCloser } from "nostr-tools/abstract-pool";
import { decrypt, encrypt } from "nostr-tools/nip44";
import { getConversationKey } from "nostr-tools/nip44";
import { NIP05_REGEX } from "nostr-tools/nip05";
import { Handlerinformation, NostrConnect } from "nostr-tools/kinds";

let _fetch: any;
if (typeof fetch !== "undefined") {
  _fetch = fetch;
}

export function useFetchImplementation(fetchImplementation: any) {
  _fetch = fetchImplementation;
}

export const BUNKER_REGEX = /^bunker:\/\/([0-9a-f]{64})\??([?\/\w:.=&%-]*)$/;

export type BunkerPointer = {
  relays: string[];
  pubkey: string;
  secret: null | string;
};

export function toBunkerURL(bunkerPointer: BunkerPointer): string {
  const bunkerURL = new URL(`bunker://${bunkerPointer.pubkey}`);
  bunkerPointer.relays.forEach((relay) => {
    bunkerURL.searchParams.append("relay", relay);
  });
  if (bunkerPointer.secret) {
    bunkerURL.searchParams.set("secret", bunkerPointer.secret);
  }
  return bunkerURL.toString();
}

export async function parseBunkerInput(
  input: string,
): Promise<BunkerPointer | null> {
  const match = input.match(BUNKER_REGEX);
  if (match) {
    try {
      const pubkey = match[1];
      const qs = new URLSearchParams(match[2]);
      return {
        pubkey,
        relays: qs.getAll("relay"),
        secret: qs.get("secret"),
      };
    } catch (_err) {
      /* just move to the next case */
    }
  }

  return queryBunkerProfile(input);
}

export async function queryBunkerProfile(
  nip05: string,
): Promise<BunkerPointer | null> {
  const match = nip05.match(NIP05_REGEX);
  if (!match) return null;

  const [_, name = "_", domain] = match;

  try {
    const url = `https://${domain}/.well-known/nostr.json?name=${name}`;
    const res = await (await _fetch(url, { redirect: "error" })).json();

    const pubkey = res.names[name];
    const relays = res.nip46[pubkey] || [];

    return { pubkey, relays, secret: null };
  } catch (_err) {
    return null;
  }
}

export type NostrConnectParams = {
  clientPubkey: string;
  relays: string[];
  secret: string;
  perms?: string[];
  name?: string;
  url?: string;
  image?: string;
};

export type ParsedNostrConnectURI = {
  protocol: "nostrconnect";
  clientPubkey: string;
  params: {
    relays: string[];
    secret: string;
    perms?: string[];
    name?: string;
    url?: string;
    image?: string;
  };
  originalString: string;
};

export function createNostrConnectURI(params: NostrConnectParams): string {
  if (!params.clientPubkey) {
    throw new Error("clientPubkey is required.");
  }
  if (!params.relays || params.relays.length === 0) {
    throw new Error("At least one relay is required.");
  }
  if (!params.secret) {
    throw new Error("secret is required.");
  }

  const queryParams = new URLSearchParams();

  params.relays.forEach((relay) => {
    queryParams.append("relay", relay);
  });

  queryParams.append("secret", params.secret);

  if (params.perms && params.perms.length > 0) {
    queryParams.append("perms", params.perms.join(","));
  }
  if (params.name) {
    queryParams.append("name", params.name);
  }
  if (params.url) {
    queryParams.append("url", params.url);
  }
  if (params.image) {
    queryParams.append("image", params.image);
  }

  return `nostrconnect://${params.clientPubkey}?${queryParams.toString()}`;
}

export function parseNostrConnectURI(uri: string): ParsedNostrConnectURI {
  if (!uri.startsWith("nostrconnect://")) {
    throw new Error(
      'Invalid nostrconnect URI: Must start with "nostrconnect://".',
    );
  }

  const [protocolAndPubkey, queryString] = uri.split("?");
  if (!protocolAndPubkey || !queryString) {
    throw new Error("Invalid nostrconnect URI: Missing query string.");
  }

  const clientPubkey = protocolAndPubkey.substring("nostrconnect://".length);
  if (!clientPubkey) {
    throw new Error("Invalid nostrconnect URI: Missing client-pubkey.");
  }

  const queryParams = new URLSearchParams(queryString);

  const relays = queryParams.getAll("relay");
  if (relays.length === 0) {
    throw new Error('Invalid nostrconnect URI: Missing "relay" parameter.');
  }

  const secret = queryParams.get("secret");
  if (!secret) {
    throw new Error('Invalid nostrconnect URI: Missing "secret" parameter.');
  }

  const permsString = queryParams.get("perms");
  const perms = permsString ? permsString.split(",") : undefined;

  const name = queryParams.get("name") || undefined;
  const url = queryParams.get("url") || undefined;
  const image = queryParams.get("image") || undefined;

  return {
    protocol: "nostrconnect",
    clientPubkey,
    params: {
      relays,
      secret,
      perms,
      name,
      url,
      image,
    },
    originalString: uri,
  };
}

export type BunkerSignerParams = {
  pool?: AbstractSimplePool;
  onauth?: (url: string) => void;
};

export class BunkerSigner {
  private params: BunkerSignerParams;
  private pool: AbstractSimplePool;
  private subCloser: SubCloser | undefined;
  private isOpen: boolean;
  private serial: number;
  private idPrefix: string;
  private listeners: {
    [id: string]: {
      resolve: (_: string) => void;
      reject: (_: string) => void;
    };
  };
  private waitingForAuth: { [id: string]: boolean };
  private secretKey: Uint8Array;
  private conversationKey!: Uint8Array;
  public bp!: BunkerPointer;

  private cachedPubKey: string | undefined;

  private constructor(clientSecretKey: Uint8Array, params: BunkerSignerParams) {
    this.params = params;
    this.pool = params.pool || new SimplePool();
    this.secretKey = clientSecretKey;
    this.isOpen = false;
    this.idPrefix = Math.random().toString(36).substring(7);
    this.serial = 0;
    this.listeners = {};
    this.waitingForAuth = {};
  }

  public static fromBunker(
    clientSecretKey: Uint8Array,
    bp: BunkerPointer,
    params: BunkerSignerParams = {},
  ): BunkerSigner {
    if (bp.relays.length === 0) {
      throw new Error("No relays specified for this bunker");
    }

    const signer = new BunkerSigner(clientSecretKey, params);

    signer.conversationKey = getConversationKey(clientSecretKey, bp.pubkey);
    signer.bp = bp;

    signer.setupSubscription(params);
    return signer;
  }

  public static async fromURI(
    clientSecretKey: Uint8Array,
    connectionURI: string,
    params: BunkerSignerParams = {},
    maxWait: number = 60 * 1000,
  ): Promise<BunkerSigner> {
    const signer = new BunkerSigner(clientSecretKey, params);
    const parsedURI = parseNostrConnectURI(connectionURI);
    const clientPubkey = getPublicKey(clientSecretKey);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (sub) sub.close();
        reject(
          new Error(`Connection timed out after ${maxWait / 1000} seconds`),
        );
      }, maxWait);

      const sub = signer.pool.subscribe(
        parsedURI.params.relays,
        { kinds: [NostrConnect], "#p": [clientPubkey] },
        {
          onevent: async (event: NostrEvent) => {
            try {
              const tempConvKey = getConversationKey(
                clientSecretKey,
                event.pubkey,
              );
              const decryptedContent = decrypt(event.content, tempConvKey);

              const response = JSON.parse(decryptedContent);

              if (response.result === parsedURI.params.secret) {
                clearTimeout(timer);
                sub.close();

                signer.bp = {
                  pubkey: event.pubkey,
                  relays: parsedURI.params.relays,
                  secret: parsedURI.params.secret,
                };
                signer.conversationKey = getConversationKey(
                  clientSecretKey,
                  event.pubkey,
                );
                signer.setupSubscription(params);
                resolve(signer);
              }
            } catch (e) {
              console.warn("Failed to process potential connection event", e);
            }
          },
          onclose: () => {
            clearTimeout(timer);
            reject(
              new Error(
                "Subscription closed before connection was established.",
              ),
            );
          },
          maxWait,
        },
      );
    });
  }

  private setupSubscription(params: BunkerSignerParams) {
    const listeners = this.listeners;
    const waitingForAuth = this.waitingForAuth;
    const convKey = this.conversationKey;

    this.subCloser = this.pool.subscribe(
      this.bp.relays,
      {
        kinds: [NostrConnect],
        authors: [this.bp.pubkey],
        "#p": [getPublicKey(this.secretKey)],
      },
      {
        onevent: async (event: NostrEvent) => {
          try {
            const o = JSON.parse(decrypt(event.content, convKey));
            const { id, result, error } = o;

            if (result === "auth_url" && waitingForAuth[id]) {
              delete waitingForAuth[id];

              if (params.onauth) {
                params.onauth(error);
              } else {
                console.warn(
                  `nostr-tools/nip46: remote signer ${this.bp.pubkey} tried to send an "auth_url"='${error}' but there was no onauth() callback configured.`,
                );
              }
              return;
            }

            const handler = listeners[id];
            if (handler) {
              if (error) handler.reject(error);
              else if (result) handler.resolve(result);
              delete listeners[id];
            }
          } catch (e) {
            console.warn("NIP-46: failed to process event from bunker", e);
          }
        },
        onclose: () => {
          this.subCloser = undefined;
        },
      },
    );
    this.isOpen = true;
  }

  async close() {
    this.isOpen = false;
    if (this.subCloser) {
      this.subCloser.close();
    }
  }

  async sendRequest(
    method: string,
    params: string[],
    timeout: number = 60_000,
  ): Promise<string> {
    return new Promise(async (resolve, reject) => {
      try {
        if (!this.isOpen)
          throw new Error("this signer is not open anymore, create a new one");
        if (!this.subCloser) this.setupSubscription(this.params);

        this.serial++;
        const id = `${this.idPrefix}-${this.serial}`;

        const timer = setTimeout(() => {
          delete this.listeners[id];
          delete this.waitingForAuth[id];
          reject(
            new Error(
              `NIP-46 request "${method}" timed out after ${timeout / 1000}s (id=${id})`,
            ),
          );
        }, timeout);

        const encryptedContent = encrypt(
          JSON.stringify({ id, method, params }),
          this.conversationKey,
        );

        const verifiedEvent: VerifiedEvent = finalizeEvent(
          {
            kind: NostrConnect,
            tags: [["p", this.bp.pubkey]],
            content: encryptedContent,
            created_at: Math.floor(Date.now() / 1000),
          },
          this.secretKey,
        );

        this.listeners[id] = {
          resolve: (result: string) => {
            clearTimeout(timer);
            resolve(result);
          },
          reject: (err: string) => {
            clearTimeout(timer);
            reject(new Error(err));
          },
        };
        this.waitingForAuth[id] = true;

        await Promise.any(this.pool.publish(this.bp.relays, verifiedEvent));
      } catch (err) {
        reject(err);
      }
    });
  }

  async ping(): Promise<void> {
    const resp = await this.sendRequest("ping", []);
    if (resp !== "pong") throw new Error(`result is not pong: ${resp}`);
  }

  async connect(): Promise<void> {
    await this.sendRequest("connect", [this.bp.pubkey, this.bp.secret || ""]);
  }

  async getPublicKey(): Promise<string> {
    if (!this.cachedPubKey) {
      this.cachedPubKey = await new Promise<string>((resolve, reject) => {
        setTimeout(() => {
          this.sendRequest("get_public_key", []).then(resolve, reject);
        }, 5000);
      });
    }
    return this.cachedPubKey;
  }

  async signEvent(event: EventTemplate): Promise<VerifiedEvent> {
    const resp = await this.sendRequest("sign_event", [JSON.stringify(event)]);
    const signed: NostrEvent = JSON.parse(resp);
    if (verifyEvent(signed)) {
      return signed;
    } else {
      throw new Error(
        `event returned from bunker is improperly signed: ${JSON.stringify(
          signed,
        )}`,
      );
    }
  }

  async nip04Encrypt(
    thirdPartyPubkey: string,
    plaintext: string,
  ): Promise<string> {
    return await this.sendRequest("nip04_encrypt", [
      thirdPartyPubkey,
      plaintext,
    ]);
  }

  async nip04Decrypt(
    thirdPartyPubkey: string,
    ciphertext: string,
  ): Promise<string> {
    return await this.sendRequest("nip04_decrypt", [
      thirdPartyPubkey,
      ciphertext,
    ]);
  }

  async nip44Encrypt(
    thirdPartyPubkey: string,
    plaintext: string,
  ): Promise<string> {
    return await this.sendRequest("nip44_encrypt", [
      thirdPartyPubkey,
      plaintext,
    ]);
  }

  async nip44Decrypt(
    thirdPartyPubkey: string,
    ciphertext: string,
  ): Promise<string> {
    return await this.sendRequest("nip44_decrypt", [
      thirdPartyPubkey,
      ciphertext,
    ]);
  }
}

export async function createAccount(
  bunker: BunkerProfile,
  params: BunkerSignerParams,
  username: string,
  domain: string,
  email?: string,
  localSecretKey: Uint8Array = generateSecretKey(),
): Promise<BunkerSigner> {
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (email && !EMAIL_REGEX.test(email)) throw new Error("Invalid email");

  const rpc = BunkerSigner.fromBunker(
    localSecretKey,
    bunker.bunkerPointer,
    params,
  );

  const pubkey = await rpc.sendRequest("create_account", [
    username,
    domain,
    email || "",
  ]);

  rpc.bp.pubkey = pubkey;
  await rpc.connect();

  return rpc;
}

export async function fetchBunkerProviders(
  pool: AbstractSimplePool,
  relays: string[],
): Promise<BunkerProfile[]> {
  const events = await pool.querySync(relays, {
    kinds: [Handlerinformation],
    "#k": [NostrConnect.toString()],
  });

  events.sort((a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at);

  const validatedBunkers = await Promise.all(
    events.map(async (event: NostrEvent, i: number) => {
      try {
        const content = JSON.parse(event.content);

        try {
          if (
            events.findIndex(
              (ev: NostrEvent) => JSON.parse(ev.content).nip05 === content.nip05,
            ) !== i
          )
            return undefined;
        } catch (err) {
          /***/
        }

        const bp = await queryBunkerProfile(content.nip05);
        if (bp && bp.pubkey === event.pubkey && bp.relays.length) {
          return {
            bunkerPointer: bp,
            nip05: content.nip05,
            domain: content.nip05.split("@")[1],
            name: content.name || content.display_name,
            picture: content.picture,
            about: content.about,
            website: content.website,
            local: false,
          };
        }
      } catch (err) {
        return undefined;
      }
    }),
  );

  return validatedBunkers.filter((b): b is BunkerProfile => b !== undefined);
}

export type BunkerProfile = {
  bunkerPointer: BunkerPointer;
  domain: string;
  nip05: string;
  name: string;
  picture: string;
  about: string;
  website: string;
  local: boolean;
};

export const Nip46Relays = ["wss://relay.nsec.app", "wss://nostr.oxtr.dev"];
