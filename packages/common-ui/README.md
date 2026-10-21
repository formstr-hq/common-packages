# @formstr/common-ui

Shared UI for the Formstr suite. The first component is the hidden app drawer: one identity across Forms, Calendar, Pages, Drive, Mail, Pollerama and NIPs. The package is the home for future common UI primitives.

The desk is a **small drawer of apps** — each product's own mark and name, nothing else. Most products open it from a hidden mark inside their logo: the asterisk in the Formstr wordmark, the underline in Pages, the asterisk stamp on the Drive documents, the centre node in NIPs. The logo keeps its own "home" action; only the mark opens the drawer.

**Calendar is the exception.** Its wordmark stays untouched; the drawer lives in the sidebar footer next to About / Privacy / Contact, and in the mobile **Apps** tab.

The five core apps sit in the grid. **Social** is one group tile that opens Pollerama and Standards (NIPs) underneath it, so the community pair stays together.

## Install

```sh
pnpm add @formstr/common-ui
```

Import the styles once, at the app root:

```ts
import '@formstr/common-ui/styles.css';
```

## Use

```tsx
import { useRef } from 'react';
import { SuiteDesk, type SuiteDeskHandle } from '@formstr/common-ui';

export function Shell() {
  const desk = useRef<SuiteDeskHandle>(null);

  return (
    <>
      {/* The hidden mark lives inside your logo. */}
      <button
        type="button"
        aria-label="Open the Formstr app desk"
        onClick={(event) => desk.current?.open(event.currentTarget, 'pages')}
      >
        ✳
      </button>

      <SuiteDesk ref={desk} currentAppId="pages" />
    </>
  );
}
```

`SuiteDesk` renders through a portal, positions itself against the element you pass to `open()`, and falls back to a bottom sheet below 640px.

### Keeping the logo's home action

The mark and the rest of the logo must be **siblings**, never nested buttons or links:

```tsx
<div className="brand-lockup">
  <a href="/" aria-label="Pages home">
    <PagesMark />
  </a>
  <button
    type="button"
    className="brand-lockup__suite"
    aria-label="Open the Formstr app desk"
    onClick={(event) => desk.current?.open(event.currentTarget, 'pages')}
  >
    ✳
  </button>
</div>
```

Position the suite button over the hidden element with CSS. Give it a real hit area (at least 44×44 on touch) even when the visual mark is small. The rest of the lockup stays a home link.

### Logo marks

The mark is always the only accented element in the lockup. That colour is the affordance — it should read as “this is different” before hover.

| Product | Hidden in | Accent |
| --- | --- | --- |
| Forms | the asterisk in the wordmark | orange |
| Calendar | no logo mark — sidebar footer / mobile Apps tab | blue |
| Pages | the underline (and the star at its end) | purple |
| Drive | the asterisk stamp on the documents | ember / ink |
| Mail | the asterisk over the envelope | red |
| Pollerama | the trailing star | pink |
| NIPs | the centre node of the trust mark | slate |

### Native shells

Pass `onNavigate` to intercept links. Call `event.preventDefault()` and open the system browser / Capacitor Browser:

```tsx
<SuiteDesk
  onNavigate={(app, event) => {
    if (!isNative) return;
    event.preventDefault();
    window.open(app.url, '_system');
  }}
/>
```

## Public registry

`APPS` is the public product list. This package is open source and published to npm, so **private tools must never be added here** — a `private: true` flag would still ship the name and URL. Private products belong in a separate config merged at deploy time, ideally behind an internal portal.

Adding a public product means adding one entry to `src/registry.ts`:

```ts
{
  id: 'pages',
  label: 'Pages',
  description: 'Encrypted Markdown pages.',
  url: 'https://pages.formstr.app',
  hosts: ['pages.formstr.app'],
  group: 'apps',
  ink: { light: '#6B4FA3', dark: '#B79CE8' },
}
```

`hosts` powers `appForHost()` / `appIdForHost()` so each product can detect itself.

## API

### `<SuiteDesk />`

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `apps` | `readonly FormstrApp[]` | `APPS` | Public product list. |
| `currentAppId` | `string` | — | Marked with a dot in the drawer. |
| `theme` | `'auto' \| 'light' \| 'dark'` | `'auto'` | `auto` follows `prefers-color-scheme`. |
| `className` | `string` | — | Extra class on the panel. |
| `style` | `CSSProperties` | — | Host theme tokens; see below. |
| `onNavigate` | `(app, event) => void` | — | Intercept before navigation. |
| `title` | `string` | `'Apps'` | Small heading above the grid. |

### Theming

The drawer follows the host app instead of carrying its own palette. Pass the app's MUI tokens as CSS variables:

```tsx
<SuiteDesk
  style={
    {
      '--fs-desk-bg': theme.palette.background.paper,
      '--fs-desk-ink': theme.palette.text.primary,
      '--fs-desk-muted': theme.palette.text.secondary,
      '--fs-desk-line': theme.palette.divider,
      '--fs-desk-line-strong': theme.palette.divider,
      '--fs-desk-hover': theme.palette.action.hover,
      '--fs-desk-radius': `${theme.shape.borderRadius}px`,
      '--fs-desk-shadow': theme.shadows[8],
    } as CSSProperties
  }
/>
```

The app inks stay product-branded; the surface, text, borders and radius come from the host. `theme` still chooses the light/dark mode for the ink fallbacks.

### `SuiteDeskHandle`

- `open(anchor: HTMLElement, appId?: string)` — opens anchored to `anchor`.
- `close()` — closes without stealing focus.

### `<Asterisk />`

The suite mark as a plain SVG, `currentColor`, no palette of its own. Use it inside a logo or as the visual for the hidden trigger. Pass `pulse` for the slow suite pulse, or add the exported `fs-suite-pulse` class to a mark group in your logo.

```tsx
<Asterisk size={14} pulse />
```

## Development

```sh
pnpm build
pnpm typecheck
pnpm test
```
