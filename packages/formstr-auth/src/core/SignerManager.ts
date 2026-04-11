import { nip19, generateSecretKey } from "nostr-tools";
import * as nip49 from "nostr-tools/nip49";
import { bytesToHex } from "nostr-tools/utils";

import { nip07Signer } from "./NIP07Signer";
import { createNip46Signer } from "./NIP46Signer";
import { createLocalSigner } from "./LocalSigner";
import { createNIP55Signer } from "./NIP55Signer";
import { DeferredSigner } from "./DeferredSigner";
import { NostrSigner, IUser } from "./types";
import {
  getBunkerUriInLocalStorage,
  getKeysFromLocalStorage,
  setBunkerUriInLocalStorage,
  setKeysInLocalStorage,
  getUserDataFromLocalStorage,
  setUserDataInLocalStorage,
  clearAuthStorage,
  getNcryptsecFromLocalStorage,
  setNcryptsecInLocalStorage,
  getSessionSecret,
  setSessionSecret,
} from "./utils";
import { fetchUserProfile, publishEvent } from "../utils/nostr";
import { isNative } from "../utils/platform";

const ANONYMOUS_USER_NAME = "";
const DEFAULT_IMAGE_URL = "";

export class SignerManager {
  private signer: NostrSigner | null = null;
  private user: IUser | null = null;
  private onChangeCallbacks: Set<() => void> = new Set();
  private initialized = false;

  constructor() {}

  /**
   * Initializes the manager by restoring any existing session from storage.
   */
  async init() {
    if (this.initialized) return;
    
    const cachedUser = getUserDataFromLocalStorage();
    if (cachedUser) this.user = cachedUser.user;
    
    const keys = getKeysFromLocalStorage();

    // Phase 1: Set up a deferred signer if we have a pubkey
    let deferredSigner: DeferredSigner | null = null;
    if (keys?.pubkey) {
      deferredSigner = new DeferredSigner(keys.pubkey);
      this.signer = deferredSigner;
      this.notify();
    }

    // Phase 2: Restore the real signer in the background
    try {
      const bunkerUri = getBunkerUriInLocalStorage();

      // 1. Try Session Cache (Survives reload)
      const sessionSecret = getSessionSecret();
      if (sessionSecret && keys?.pubkey) {
        await this.loginWithLocalKey(keys.pubkey, sessionSecret);
      }
      // 2. Try NIP-46 (Bunker)
      else if (bunkerUri?.bunkerUri) {
        await this.loginWithNip46(bunkerUri.bunkerUri);
      } 
      // 3. Try NIP-07 (Extension) - only on web
      else if (!isNative && window.nostr && keys?.pubkey && !keys?.secret) {
        await this.loginWithNip07();
      }
      // 4. Try Local Key (Guest/nsec - will be device-encrypted if using new utils)
      else if (keys?.pubkey && keys?.secret) {
        await this.loginWithLocalKey(keys.pubkey, keys.secret);
      }

      // If we recovered a real signer, resolve the deferred one
      if (deferredSigner && this.signer && this.signer !== deferredSigner) {
        deferredSigner.resolve(this.signer);
      }
    } catch (e) {
      console.error("SignerManager: failed to restore session", e);
    }

    this.initialized = true;
    this.notify();
  }

  private async loginWithLocalKey(pubkey: string, privkey: string) {
    this.signer = createLocalSigner(privkey);
    if (!this.user) {
      await this.saveUser(pubkey);
    }
  }

  async loginWithNsec(nsec: string) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error("Invalid nsec");
    
    const privkey = bytesToHex(decoded.data as Uint8Array);
    this.signer = createLocalSigner(privkey);
    const pubkey = await this.signer.getPublicKey();

    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey, privkey);
    this.notify();
  }

  async loginWithNip07() {
    if (!window.nostr) throw new Error("NIP-07 extension not found");
    this.signer = nip07Signer;
    const pubkey = await window.nostr.getPublicKey();
    
    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey);
    this.notify();
  }

  async loginWithNip46(bunkerUri: string) {
    const remoteSigner = await createNip46Signer(bunkerUri);
    const pubkey = await remoteSigner.getPublicKey();
    
    this.signer = remoteSigner;
    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey);
    setBunkerUriInLocalStorage(bunkerUri);
    this.notify();
  }

  async loginWithNip55(packageName: string, cachedPubkey?: string) {
    const signer = createNIP55Signer(packageName, cachedPubkey);
    const pubkey = await signer.getPublicKey();

    this.signer = signer;
    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey);
    // Note: We don't save package name in standard utils yet, 
    // but NIP-55 apps usually handle their own state.
    this.notify();
  }

  async loginWithPrivkey(privkey: string) {
    try {
      let hexKey = privkey;
      if (privkey.startsWith("nsec")) {
        const decoded = nip19.decode(privkey);
        if (decoded.type === "nsec") {
          hexKey = bytesToHex(decoded.data as Uint8Array);
        }
      }

      this.signer = createLocalSigner(hexKey);
      const pubkey = await this.signer.getPublicKey();
      await this.saveUser(pubkey);
      setKeysInLocalStorage(pubkey, hexKey);
    } catch (e: any) {
      throw new Error(e.message || "Invalid private key");
    }
  }

  async loginAsGuest(privkey: string) {
    this.signer = createLocalSigner(privkey);
    const pubkey = await this.signer.getPublicKey();
    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey, privkey);
  }

  async loginWithNcryptsec(ncryptsec: string, password: string) {
    const secretKey = nip49.decrypt(ncryptsec, password);
    const privkeyHex = bytesToHex(secretKey);
    
    this.signer = createLocalSigner(privkeyHex);
    const pubkey = await this.signer.getPublicKey();
    
    await this.saveUser(pubkey);
    setKeysInLocalStorage(pubkey); // Store pubkey locally
    setNcryptsecInLocalStorage(ncryptsec); // Store encrypted key
    setSessionSecret(privkeyHex); // Cache for reload
    this.notify();
  }

  async signUpWithPassword(password: string, metadata: Partial<IUser>) {
    const secretKey = generateSecretKey();
    const privkeyHex = bytesToHex(secretKey);
    const ncryptsec = nip49.encrypt(secretKey, password);
    
    this.signer = createLocalSigner(privkeyHex);
    const pubkey = await this.signer.getPublicKey();

    // 1. Set internal state
    this.user = { pubkey, ...metadata };
    setUserDataInLocalStorage(this.user);
    
    // 2. Persist encrypted storage
    setKeysInLocalStorage(pubkey);
    setNcryptsecInLocalStorage(ncryptsec);
    setSessionSecret(privkeyHex);

    // 3. Publish Kind 0 (Fire and forget)
    this.publishProfile(pubkey, metadata).catch(console.error);
    
    this.notify();
    return ncryptsec;
  }

  private async publishProfile(pubkey: string, metadata: Partial<IUser>) {
    if (!this.signer) return;
    const content = JSON.stringify({
      name: metadata.name,
      display_name: metadata.display_name,
      about: metadata.about,
      picture: metadata.picture,
      nip05: metadata.nip05,
      lud16: metadata.lud16,
    });
    
    const event = {
      kind: 0,
      pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content,
    };
    
    const signedEvent = await this.signer.signEvent(event);
    await publishEvent(signedEvent);
  }

  async logout() {
    this.signer = null;
    this.user = null;
    clearAuthStorage();
    this.notify();
  }

  private async saveUser(pubkey: string, retryCount = 0) {
    try {
      const event = await fetchUserProfile(pubkey);
      const profile = event ? JSON.parse(event.content) : {};
      
      const hasMetadata = !!profile.name || !!profile.picture;
      const existing = this.user?.pubkey === pubkey ? this.user : getUserDataFromLocalStorage()?.user;

      const userData: IUser = {
        pubkey,
        name: profile.name || existing?.name || ANONYMOUS_USER_NAME,
        display_name: profile.display_name || profile.name || existing?.display_name || existing?.name || ANONYMOUS_USER_NAME,
        picture: profile.picture || existing?.picture || DEFAULT_IMAGE_URL,
        about: profile.about || existing?.about,
        nip05: profile.nip05 || existing?.nip05,
        lud16: profile.lud16 || existing?.lud16,
      };
      
      this.user = userData;
      setUserDataInLocalStorage(userData);
      this.notify();

      // If we didn't find metadata and haven't exhausted retries, try again later
      if (!hasMetadata && retryCount < 3) {
        const delays = [5000, 15000, 30000]; // 5s, 15s, 30s intervals
        setTimeout(() => this.saveUser(pubkey, retryCount + 1), delays[retryCount]);
      }

      return userData;
    } catch (e) {
      const existing = this.user?.pubkey === pubkey ? this.user : getUserDataFromLocalStorage()?.user;
      if (existing) {
        this.user = existing;
        this.notify();
        return existing;
      }
      
      const fallback: IUser = { pubkey, name: ANONYMOUS_USER_NAME, picture: DEFAULT_IMAGE_URL };
      this.user = fallback;
      this.notify();
      return fallback;
    }
  }

  // --- Getters & Listeners ---

  getSigner(): NostrSigner | null {
    return this.signer;
  }

  getUser(): IUser | null {
    return this.user;
  }

  onUserChange(cb: () => void) {
    this.onChangeCallbacks.add(cb);
    return () => {
      this.onChangeCallbacks.delete(cb);
    };
  }

  private notify() {
    this.onChangeCallbacks.forEach((cb) => cb());
  }
}

// Export a singleton instance
export const signerManager = new SignerManager();
