import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { encrypt as nip49Encrypt, decrypt as nip49Decrypt } from 'nostr-tools/nip49';

export function encryptSecretKey(secretKey: Uint8Array, passphrase: string): string {
  return nip49Encrypt(secretKey, passphrase);
}

export function decryptNcryptsec(ncryptsec: string, passphrase: string): Uint8Array {
  return nip49Decrypt(ncryptsec, passphrase);
}

export interface GeneratedAccount {
  secretKey: Uint8Array;
  pubkey: string;
  npub: string;
  ncryptsec: string;
}

export function generateAccount(passphrase: string): GeneratedAccount {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const npub = nip19.npubEncode(pubkey);
  const ncryptsec = nip49Encrypt(secretKey, passphrase);
  return { secretKey, pubkey, npub, ncryptsec };
}
