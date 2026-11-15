import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWindowNostr, hasNostrExtension, watchNostrExtension } from '../src/index.js';

const provider = () => ({ getPublicKey: vi.fn(), signEvent: vi.fn() });
function browser() {
  const mock = Object.assign(new EventTarget(), {
    nostr: undefined as unknown,
    setInterval,
    clearInterval,
  });
  vi.stubGlobal('window', mock);
  return mock;
}
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('NIP-07 detection', () => {
  it('reports false outside a browser even with a global provider', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('nostr', provider());
    expect(hasNostrExtension()).toBe(false);
    // Existing non-browser signing API remains supported.
    expect(getWindowNostr()).toBe((globalThis as { nostr?: unknown }).nostr);
  });

  it.each([
    undefined, null, {}, { signEvent: vi.fn() }, { getPublicKey: vi.fn() },
    { getPublicKey: 'key', signEvent: vi.fn() },
    { getPublicKey: vi.fn(), signEvent: true },
  ])('rejects incomplete providers: %j', (nostr) => {
    browser().nostr = nostr;
    expect(hasNostrExtension()).toBe(false);
    expect(getWindowNostr).toThrow(/NIP-07 extension unavailable.*enable.*website/);
  });

  it('detects a valid provider without invoking methods', () => {
    const mock = browser();
    const nostr = provider();
    mock.nostr = nostr;
    expect(hasNostrExtension()).toBe(true);
    expect(getWindowNostr()).toBe(nostr);
    expect(nostr.getPublicKey).not.toHaveBeenCalled();
    expect(nostr.signEvent).not.toHaveBeenCalled();
  });
});

describe('NIP-07 observation', () => {
  it('immediately reports availability and polls injection, removal, and capability changes', () => {
    vi.useFakeTimers();
    const mock = browser();
    const changed = vi.fn();
    stops.push(watchNostrExtension(changed));
    expect(changed.mock.calls).toEqual([[false]]);
    mock.nostr = provider();
    vi.advanceTimersByTime(499);
    expect(changed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(changed.mock.calls).toEqual([[false], [true]]);
    vi.advanceTimersByTime(1500);
    expect(changed).toHaveBeenCalledTimes(2);
    mock.nostr = { getPublicKey: vi.fn() };
    vi.advanceTimersByTime(500);
    mock.nostr = provider();
    vi.advanceTimersByTime(500);
    mock.nostr = undefined;
    vi.advanceTimersByTime(500);
    expect(changed.mock.calls).toEqual([[false], [true], [false], [true], [false]]);
  });

  it('reports initial true, rechecks focus, and removes its timer and listener', () => {
    vi.useFakeTimers();
    const mock = browser();
    mock.nostr = provider();
    const add = vi.spyOn(mock, 'addEventListener');
    const remove = vi.spyOn(mock, 'removeEventListener');
    const changed = vi.fn();
    const stop = watchNostrExtension(changed);
    stops.push(stop);
    expect(changed.mock.calls).toEqual([[true]]);
    expect(add).toHaveBeenCalledTimes(1);
    mock.nostr = undefined;
    mock.dispatchEvent(new Event('focus'));
    mock.dispatchEvent(new Event('focus'));
    expect(changed.mock.calls).toEqual([[true], [false]]);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('focus', add.mock.calls[0]![1]);
    mock.nostr = provider();
    mock.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('reports once outside a browser without scheduling work', () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', undefined);
    const changed = vi.fn();
    const stop = watchNostrExtension(changed);
    stop();
    expect(changed.mock.calls).toEqual([[false]]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
