import { describe, expect, it } from 'vitest';

import { APPS, APP_GROUPS, appForHost, appIdForHost } from '../src/registry.js';

describe('APPS', () => {
  it('lists the public suite in the agreed order', () => {
    expect(APPS.map((app) => app.id)).toEqual([
      'forms',
      'calendar',
      'pages',
      'drive',
      'mail',
      'pollerama',
      'nips',
    ]);
  });

  it('has unique ids and hosts', () => {
    const ids = APPS.map((app) => app.id);
    expect(new Set(ids).size).toBe(ids.length);

    const owners = new Map<string, string>();
    for (const app of APPS) {
      for (const host of app.hosts) {
        const key = host.replace(/^www\./, '');
        const owner = owners.get(key);
        if (owner) expect(owner).toBe(app.id);
        owners.set(key, app.id);
      }
    }
  });

  it('only exposes https URLs', () => {
    for (const app of APPS) {
      expect(app.url).toMatch(/^https:\/\//);
      expect(app.hosts.length).toBeGreaterThan(0);
    }
  });

  it('has no empty groups', () => {
    for (const group of APP_GROUPS) {
      expect(APPS.some((app) => app.group === group.id)).toBe(true);
    }
  });
});

describe('appForHost', () => {
  it('resolves bare and www hosts, case-insensitively', () => {
    expect(appForHost('formstr.app')?.id).toBe('forms');
    expect(appForHost('WWW.Formstr.App')?.id).toBe('forms');
    expect(appForHost('calendar.formstr.app')?.id).toBe('calendar');
    expect(appForHost('mailstr.app')?.id).toBe('mail');
    expect(appForHost('nips.pollerama.fun')?.id).toBe('nips');('nips');
  });

  it('returns undefined for unknown hosts', () => {
    expect(appForHost('example.com')).toBeUndefined();
    expect(appIdForHost('localhost')).toBeUndefined();
  });
});
