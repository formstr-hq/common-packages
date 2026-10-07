import { describe, expect, it } from 'vitest';
import { bytesToMessageString, messageStringToBytes } from '../src/index.js';

describe('messageStringToBytes (§4 byte string)', () => {
  it('maps ASCII text one octet per code unit', () => {
    expect([...messageStringToBytes('hello')]).toEqual([104, 101, 108, 108, 111]);
  });

  it('masks code units above 0xff instead of silently corrupting', () => {
    // é is one UTF-16 unit (0xE9) — already a byte value.
    expect([...messageStringToBytes('é')]).toEqual([0xe9]);
    // "€" is 0x20AC — a real unicode char, not a byte string; masking keeps
    // the octet the byte-string contract would have carried.
    expect([...messageStringToBytes('\u20ac')]).toEqual([0x20ac & 0xff]); // 172
  });

  it('produces an empty array for the empty string', () => {
    expect(messageStringToBytes('').length).toBe(0);
  });
});

describe('bytesToMessageString', () => {
  it('round-trips every possible octet', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    expect([...messageStringToBytes(bytesToMessageString(bytes))]).toEqual([...bytes]);
  });

  it('round-trips multi-chunk payloads (past the 8192 unit boundary)', () => {
    const bytes = new Uint8Array(8192 + 1 + 300);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff;
    const s = bytesToMessageString(bytes);
    expect(s.length).toBe(bytes.length);
    expect([...messageStringToBytes(s)]).toEqual([...bytes]);
  });

  it('handles exact chunk-size payloads', () => {
    const bytes = new Uint8Array(0x2000);
    bytes[0] = 0xff;
    bytes[0x1fff] = 0x7f;
    const s = bytesToMessageString(bytes);
    expect(s.length).toBe(0x2000);
    expect(s.charCodeAt(0)).toBe(0xff);
    expect(s.charCodeAt(0x1fff)).toBe(0x7f);
  });
});