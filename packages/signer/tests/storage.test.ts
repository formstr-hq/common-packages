import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localStorageAdapter } from '../src/core/storage.js';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  key(i: number): string | null {
    return Array.from(this.data.keys())[i] ?? null;
  }
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, v);
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const g = globalThis as unknown as { localStorage?: Storage };

describe('localStorageAdapter', () => {
  let original: Storage | undefined;
  let memory: MemoryStorage;

  beforeEach(() => {
    memory = new MemoryStorage();
    original = g.localStorage;
    g.localStorage = memory;
  });

  afterEach(() => {
    g.localStorage = original;
  });

  it('get/set/remove with the default prefix', () => {
    const adapter = localStorageAdapter();
    adapter.set('foo', 'bar');
    expect(adapter.get('foo')).toBe('bar');
    expect(memory.getItem('@formstr/signer:foo')).toBe('bar');
    adapter.remove('foo');
    expect(adapter.get('foo')).toBeNull();
    expect(memory.getItem('@formstr/signer:foo')).toBeNull();
  });

  it('a custom prefix isolates keys between adapters', () => {
    const a = localStorageAdapter('app-a:');
    const b = localStorageAdapter('app-b:');
    a.set('k', '1');
    b.set('k', '2');
    expect(a.get('k')).toBe('1');
    expect(b.get('k')).toBe('2');
  });

  it('returns null and does not throw when localStorage is unavailable', () => {
    g.localStorage = undefined;
    const adapter = localStorageAdapter();
    expect(() => adapter.set('x', 'y')).not.toThrow();
    expect(adapter.get('x')).toBeNull();
    expect(() => adapter.remove('x')).not.toThrow();
  });

  it('swallows errors when localStorage methods throw', () => {
    g.localStorage = {
      length: 0,
      clear: () => {},
      key: () => null,
      getItem: () => {
        throw new Error('boom');
      },
      setItem: () => {
        throw new Error('boom');
      },
      removeItem: () => {
        throw new Error('boom');
      },
    } satisfies Storage;
    const adapter = localStorageAdapter();
    expect(adapter.get('x')).toBeNull();
    expect(() => adapter.set('x', 'y')).not.toThrow();
    expect(() => adapter.remove('x')).not.toThrow();
  });

  it('swallows errors when accessing localStorage itself throws', () => {
    // Some browsers (privacy mode) throw on the localStorage property access.
    const proxy = new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === 'localStorage') throw new Error('access denied');
        return undefined;
      },
    });
    // Replace globalThis with one whose `localStorage` access throws.
    const realGlobal = globalThis;
    const fakeGlobal = new Proxy(realGlobal, {
      get(target, prop, receiver) {
        if (prop === 'localStorage') throw new Error('access denied');
        return Reflect.get(target, prop, receiver);
      },
    });
    void proxy;
    // We can't replace globalThis safely. Instead, set a throwing getter on the existing globalThis.
    Object.defineProperty(realGlobal, 'localStorage', {
      get() {
        throw new Error('access denied');
      },
      configurable: true,
    });
    void fakeGlobal;
    const adapter = localStorageAdapter();
    expect(adapter.get('x')).toBeNull();
    expect(() => adapter.set('x', 'y')).not.toThrow();
    expect(() => adapter.remove('x')).not.toThrow();
    // Restore for the afterEach to do its cleanup
    Object.defineProperty(realGlobal, 'localStorage', {
      value: undefined,
      writable: true,
      configurable: true,
    });
  });
});
