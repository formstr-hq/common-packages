import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SimplePool, type Event } from 'nostr-tools';
import { DEFAULT_SETUP_RELAYS, publishSetup, createIdentity } from '../src/index.js';

vi.mock('nostr-tools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('nostr-tools')>();
  const registry: { published: { relays: string[]; event: unknown }[] } = { published: [] };
  class FakePool {
    static registry = registry;
    // Resolve every relay but the second, which rejects like an auth-gated relay.
    publish(relays: string[], event: unknown): Promise<string>[] {
      registry.published.push({ relays, event });
      return relays.map((relay, i) =>
        i === 1 ? Promise.reject(new Error('auth-required: closed')) : Promise.resolve(''),
      );
    }
  }
  return { ...actual, SimplePool: FakePool };
});

const fake = SimplePool as unknown as { registry: { published: { relays: string[]; event: Event }[] } };

beforeEach(() => {
  fake.registry.published = [];
});

describe('publishSetup', () => {
  it('publishes a kind-0 profile and a kind-10050 relay list to the default relays', async () => {
    const id = createIdentity();
    const out = await publishSetup(id.secretKey, {
      name: 'irona',
      nip05: 'irona@mailstr.app',
      about: 'Irona — self-sovereign mail agent.',
    });

    expect(fake.registry.published).toHaveLength(2);
    const [profileCall, relaysCall] = fake.registry.published;
    expect(profileCall.relays).toEqual(DEFAULT_SETUP_RELAYS);
    expect(relaysCall.relays).toEqual(DEFAULT_SETUP_RELAYS);

    const profile = profileCall.event;
    expect(profile.kind).toBe(0);
    expect(profile.pubkey).toBe(id.pubkey);
    expect(JSON.parse(profile.content)).toEqual({
      name: 'irona',
      nip05: 'irona@mailstr.app',
      about: 'Irona — self-sovereign mail agent.',
    });

    const dmRelays = relaysCall.event;
    expect(dmRelays.kind).toBe(10050);
    expect(dmRelays.tags).toEqual(DEFAULT_SETUP_RELAYS.map((r) => ['relay', r]));
    expect(dmRelays.content).toBe('');

    // Per-relay outcomes: relay 1 rejected, the rest OK.
    expect(out.profile.eventId).toBe(profile.id);
    expect(out.dmRelays.eventId).toBe(dmRelays.id);
    expect(out.profile.results).toEqual([
      { relay: DEFAULT_SETUP_RELAYS[0], ok: true, detail: '' },
      { relay: DEFAULT_SETUP_RELAYS[1], ok: false, detail: 'Error: auth-required: closed' },
      { relay: DEFAULT_SETUP_RELAYS[2], ok: true, detail: '' },
    ]);
  });

  it('merges extra profile fields and honors custom relays', async () => {
    const id = createIdentity();
    const relays = ['wss://relay.example/x'];
    await publishSetup(id.secretKey, {
      name: 'irona',
      picture: 'https://example.test/p.png',
      profileExtra: { bot: true },
      relays,
    });
    const content = JSON.parse(fake.registry.published[0].event.content as string);
    expect(content).toEqual({ name: 'irona', picture: 'https://example.test/p.png', bot: true });
    expect(content.nip05).toBeUndefined();
    expect(fake.registry.published[1].event.tags).toEqual([['relay', relays[0]]]);
  });

  it('accepts an injected pool', async () => {
    const id = createIdentity();
    const calls: Event[] = [];
    const out = await publishSetup(id.secretKey, {
      name: 'irona',
      nip05: 'irona@mailstr.app',
      relays: ['wss://one'],
      pool: {
        publish: (_relays: string[], event: Event) => {
          calls.push(event);
          return [Promise.resolve('ok: stored')];
        },
      },
    });
    expect(calls).toHaveLength(2);
    expect(out.profile.results).toEqual([{ relay: 'wss://one', ok: true, detail: 'ok: stored' }]);
  });
});