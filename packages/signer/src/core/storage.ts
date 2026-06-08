export interface StorageAdapter {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

const DEFAULT_PREFIX = '@formstr/signer:';

export function localStorageAdapter(prefix: string = DEFAULT_PREFIX): StorageAdapter {
  const ls = (): Storage | null => {
    try {
      return typeof globalThis !== 'undefined' && globalThis.localStorage
        ? globalThis.localStorage
        : null;
    } catch {
      return null;
    }
  };
  return {
    get(key) {
      try {
        return ls()?.getItem(prefix + key) ?? null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        ls()?.setItem(prefix + key, value);
      } catch {
        // swallow quota / privacy-mode errors
      }
    },
    remove(key) {
      try {
        ls()?.removeItem(prefix + key);
      } catch {
        // swallow
      }
    },
  };
}
