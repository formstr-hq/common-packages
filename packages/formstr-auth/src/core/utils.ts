import { generateSecretKey } from "nostr-tools";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { IUser } from "./types";

const PREFIX = "formstr-auth";
const LOCAL_APP_SECRET_KEY = `${PREFIX}:client-secret`;
const LOCAL_BUNKER_URI = `${PREFIX}:bunkerUri`;
const LOCAL_STORAGE_KEYS = `${PREFIX}:keys`;
const LOCAL_USER_DATA = `${PREFIX}:userData`;
const LOCAL_DEVICE_KEY = `${PREFIX}:device-key`;
const LOCAL_NCRYPTSEC = `${PREFIX}:ncryptsec`;
const SESSION_CACHE_KEY = `${PREFIX}:session-secret`;

const USER_DATA_TTL_HOURS = 24;

type BunkerUri = { bunkerUri: string };

type UserData = {
  user: IUser;
  expiresAt: number;
};

type Keys = { pubkey: string; secret?: string };

export const getAppSecretKeyFromLocalStorage = () => {
  const stored = localStorage.getItem(LOCAL_APP_SECRET_KEY);
  if (!stored) {
    const newSecret = generateSecretKey();
    const hexSecretKey = bytesToHex(newSecret);
    localStorage.setItem(LOCAL_APP_SECRET_KEY, hexSecretKey);
    return newSecret;
  }
  return hexToBytes(stored);
};

export const getDeviceKey = () => {
  const stored = localStorage.getItem(LOCAL_DEVICE_KEY);
  if (!stored) {
    const newKey = generateSecretKey();
    const hexKey = bytesToHex(newKey);
    localStorage.setItem(LOCAL_DEVICE_KEY, hexKey);
    return newKey;
  }
  return hexToBytes(stored);
};

export const getBunkerUriInLocalStorage = () => {
  return JSON.parse(
    localStorage.getItem(LOCAL_BUNKER_URI) || "{}",
  ) as BunkerUri;
};

import { nip44 } from "nostr-tools";

export const getKeysFromLocalStorage = () => {
  const data = localStorage.getItem(LOCAL_STORAGE_KEYS);
  if (!data) return null;
  
  try {
    const parsed = JSON.parse(data) as Keys;
    if (parsed.secret) {
      // Decrypt if it looks like ciphertext (NIP-44 start with base64)
      // For simplicity, we assume if it's stored and we have a device key, we check it.
      // If it's a raw hex (legacy), we return it as is.
      if (parsed.secret.length > 64) { 
        try {
          const deviceKey = getDeviceKey();
          parsed.secret = nip44.v2.decrypt(parsed.secret, deviceKey);
        } catch (e) {
          console.warn("Failed to decrypt local secret with device key", e);
        }
      }
    }
    return parsed;
  } catch (e) {
    return null;
  }
};

export const setBunkerUriInLocalStorage = (bunkerUri: string) => {
  localStorage.setItem(LOCAL_BUNKER_URI, JSON.stringify({ bunkerUri }));
};

export const setKeysInLocalStorage = (pubkey: string, secret?: string) => {
  let secretToStore = secret;
  if (secret) {
    const deviceKey = getDeviceKey();
    secretToStore = nip44.v2.encrypt(secret, deviceKey);
  }
  localStorage.setItem(LOCAL_STORAGE_KEYS, JSON.stringify({ pubkey, secret: secretToStore }));
};

export const getNcryptsecFromLocalStorage = (): string | null => {
  return localStorage.getItem(LOCAL_NCRYPTSEC);
};

export const setNcryptsecInLocalStorage = (ncryptsec: string) => {
  localStorage.setItem(LOCAL_NCRYPTSEC, ncryptsec);
};

export const removeNcryptsecFromLocalStorage = () => {
  localStorage.removeItem(LOCAL_NCRYPTSEC);
};

// --- Session Cache (survives reload, not tab close) ---

export const getSessionSecret = (): string | null => {
  return sessionStorage.getItem(SESSION_CACHE_KEY);
};

export const setSessionSecret = (secret: string) => {
  sessionStorage.setItem(SESSION_CACHE_KEY, secret);
};

export const clearSessionSecret = () => {
  sessionStorage.removeItem(SESSION_CACHE_KEY);
};

export const setUserDataInLocalStorage = (
  user: IUser,
  ttlInHours = USER_DATA_TTL_HOURS,
) => {
  const now = new Date();
  const expiresAt = now.setHours(now.getHours() + ttlInHours);

  const userData: UserData = {
    user,
    expiresAt,
  };

  localStorage.setItem(LOCAL_USER_DATA, JSON.stringify(userData));
};

export const getUserDataFromLocalStorage = (): { user: IUser } | null => {
  const data = localStorage.getItem(LOCAL_USER_DATA);
  if (!data) return null;

  try {
    const { user, expiresAt } = JSON.parse(data) as UserData;
    const isExpired = Date.now() > expiresAt;

    if (isExpired) {
      localStorage.removeItem(LOCAL_USER_DATA);
      return null;
    }

    return { user };
  } catch (error) {
    console.error("Failed to parse user data from localStorage", error);
    return null;
  }
};

export const clearAuthStorage = () => {
  localStorage.removeItem(LOCAL_USER_DATA);
  localStorage.removeItem(LOCAL_STORAGE_KEYS);
  localStorage.removeItem(LOCAL_BUNKER_URI);
  localStorage.removeItem(LOCAL_APP_SECRET_KEY);
  localStorage.removeItem(LOCAL_DEVICE_KEY);
  localStorage.removeItem(LOCAL_NCRYPTSEC);
  clearSessionSecret();
};
