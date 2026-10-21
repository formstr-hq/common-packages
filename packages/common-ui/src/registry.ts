/**
 * The public product registry.
 *
 * This package is published to npm and lives in an open-source repository, so
 * everything here ships to the client. Only public products belong in this
 * file. Internal tools must never be added with a `private` flag — the flag
 * would still ship, along with the name and URL. Keep them in a separate
 * private config that is merged at deploy time.
 */

export type AppGroup = 'apps' | 'community';

export type AppTag = 'Social' | 'Standards';

export interface AppInk {
  /** Accent for light grounds. Tuned to clear 4.5:1 on #FAFAF8. */
  light: string;
  /** Accent for dark grounds. Tuned to clear 4.5:1 on #101211. */
  dark: string;
}

export interface FormstrApp {
  id: string;
  label: string;
  description: string;
  url: string;
  /** Hostnames that identify this product. `www.` is normalised away. */
  hosts: readonly string[];
  group: AppGroup;
  /** Optional descriptor shown under the label. */
  tag?: AppTag;
  ink: AppInk;
}

export const APP_GROUPS = [
  { id: 'apps', label: 'Apps' },
  { id: 'community', label: 'Community' },
] as const satisfies readonly { id: AppGroup; label: string }[];

export const APPS = [
  {
    id: 'forms',
    label: 'Forms',
    description: 'Create forms, collect responses.',
    url: 'https://formstr.app',
    hosts: ['formstr.app', 'www.formstr.app'],
    group: 'apps',
    ink: { light: '#A65A08', dark: '#E08A2E' },
  },
  {
    id: 'calendar',
    label: 'Calendar',
    description: 'Events, RSVPs and scheduling.',
    url: 'https://calendar.formstr.app',
    hosts: ['calendar.formstr.app'],
    group: 'apps',
    ink: { light: '#2743C4', dark: '#7B92F0' },
  },
  {
    id: 'pages',
    label: 'Pages',
    description: 'Encrypted Markdown pages.',
    url: 'https://pages.formstr.app',
    hosts: ['pages.formstr.app'],
    group: 'apps',
    ink: { light: '#6B4FA3', dark: '#B79CE8' },
  },
  {
    id: 'drive',
    label: 'Drive',
    description: 'Encrypted files on Nostr.',
    url: 'https://drive.formstr.app',
    hosts: ['drive.formstr.app'],
    group: 'apps',
    ink: { light: '#0B6B60', dark: '#3FB5A4' },
  },
  {
    id: 'mail',
    label: 'Mail',
    description: 'Nostr-native email.',
    url: 'https://mailstr.app',
    hosts: ['mailstr.app', 'www.mailstr.app'],
    group: 'apps',
    ink: { light: '#B42318', dark: '#F97066' },
  },
  {
    id: 'pollerama',
    label: 'Pollerama',
    description: 'Polls and public sentiment.',
    url: 'https://pollerama.fun',
    hosts: ['pollerama.fun', 'www.pollerama.fun'],
    group: 'community',
    tag: 'Social',
    ink: { light: '#A31E63', dark: '#E8629F' },
  },
  {
    id: 'nips',
    label: 'NIPs',
    description: 'Community-authored standards.',
    url: 'https://nips.pollerama.fun',
    hosts: ['nips.pollerama.fun'],
    group: 'community',
    tag: 'Standards',
    ink: { light: '#475467', dark: '#98A2B3' },
  },
] as const satisfies readonly FormstrApp[];

export type FormstrAppId = (typeof APPS)[number]['id'];

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, '');
}

/** Resolve the product for a hostname, ignoring `www.` and case. */
export function appForHost(
  hostname: string,
  apps: readonly FormstrApp[] = APPS,
): FormstrApp | undefined {
  const host = normalizeHost(hostname);
  return apps.find((app) => app.hosts.some((candidate) => normalizeHost(candidate) === host));
}

/** Resolve the current product id for a hostname. */
export function appIdForHost(
  hostname: string,
  apps: readonly FormstrApp[] = APPS,
): string | undefined {
  return appForHost(hostname, apps)?.id;
}
