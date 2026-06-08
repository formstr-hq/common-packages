# @formstr/signer

A vanilla TypeScript Nostr signer with optional unstyled login UI. Supports NIP-07 (extension), NIP-46 (bunker + nostrconnect), NIP-49 (ncryptsec), and NIP-55 (Android).

> Status: **alpha skeleton** — API surface defined, implementations pending.

## Install

```bash
pnpm add @formstr/signer
```

## Quick start

```ts
import { createSigner } from '@formstr/signer';

const signer = createSigner({ appName: 'my-app' });

// Create a new account (NIP-49 ncryptsec encrypted at rest)
const { npub, ncryptsec } = await signer.createAccount('my-passphrase');

// Subsequent sessions: log in with the encrypted nsec
await signer.loginWithNcryptsec(ncryptsec, 'my-passphrase');

// Or any of the other methods
await signer.loginWithExtension();
await signer.loginWithBunkerUri('bunker://...');
await signer.loginWithNostrConnect({ relays: ['wss://relay.example'] });
await signer.loginWithAndroidSigner();

// Sign events — the active signer never exposes the privkey
const active = signer.getActiveSigner()!;
const signed = await active.signEvent({ kind: 1, content: 'gm', tags: [], created_at: 0 });
```

## UI helpers

The UI module returns HTML strings. The calling code injects the markup wherever it wants and then calls `attach*Listeners()` to wire events — mirrors the `@formstr/sdk` pattern.

```ts
import { renderLoginHtml, attachLoginListeners } from '@formstr/signer/ui';
import '@formstr/signer/styles.css'; // optional

const container = document.getElementById('signer-root')!;
container.innerHTML = renderLoginHtml();
const detach = attachLoginListeners(container, signer, {
  onLogin: ({ npub }) => console.log('logged in', npub),
  onError: (err) => console.error(err),
});

// later: detach();
```

Other helpers: `renderCreateAccountHtml`, `renderNostrConnectQrHtml` (plus their `attach*Listeners` counterparts).

## Security model

- **Identity nsec at rest:** always encrypted with the user's passphrase (NIP-49). Account creation always requires a passphrase — there is no "guest" raw-nsec path.
- **Decrypted privkey:** held in memory only, for the lifetime of the page. Never written to `localStorage` or `sessionStorage`. Lost on page reload — user re-enters passphrase.
- **Active signer interface:** exposes `signEvent`, `nip04*`, `nip44*`, `getPublicKey` only. There is no method that returns the raw private key.
- **NIP-46 relays:** for bunker URIs, relays come from the URI. For nostrconnect QR flow, the UI prompts the user for relays. There is no hardcoded fallback relay list.
- **NIP-46 client secret:** the per-account ephemeral keypair used to talk to the remote signer is stored in plaintext in the configured storage adapter. This is a deliberate tradeoff — see the threat-model note below.

### Threat-model note on the NIP-46 client secret

The client secret is *not* the user's identity key — it is a disposable session key the remote signer recognizes as the client. An attacker with same-origin storage access could impersonate the client to the remote signer; whether that results in unauthorized signatures depends on whether the user has granted blanket permissions on the bunker side (out of our control). Encrypting this secret with a derivable key would not defend against same-origin XSS (the realistic attacker), so we keep it plaintext rather than adding security theater.

## BEM class catalog

The UI ships with these class names. Override in your own CSS.

| Class | Purpose |
| --- | --- |
| `.nostr-signer__root` | top-level wrapper |
| `.nostr-signer__overlay` | modal backdrop |
| `.nostr-signer__modal` | modal box |
| `.nostr-signer__header` | header bar |
| `.nostr-signer__title` | heading text |
| `.nostr-signer__close` | close button |
| `.nostr-signer__tabs` | tab bar |
| `.nostr-signer__tab` | a tab button |
| `.nostr-signer__tab--active` | currently selected tab |
| `.nostr-signer__tab--extension` | NIP-07 tab |
| `.nostr-signer__tab--bunker` | NIP-46 bunker URI tab |
| `.nostr-signer__tab--nostrconnect` | NIP-46 nostrconnect (QR) tab |
| `.nostr-signer__tab--ncryptsec` | NIP-49 ncryptsec tab |
| `.nostr-signer__tab--android` | NIP-55 Android tab |
| `.nostr-signer__panel` | tab content panel |
| `.nostr-signer__form` | form wrapper |
| `.nostr-signer__field` | field wrapper |
| `.nostr-signer__label` | input label |
| `.nostr-signer__input` | text input |
| `.nostr-signer__input--passphrase` | passphrase field |
| `.nostr-signer__input--ncryptsec` | ncryptsec field |
| `.nostr-signer__input--bunker-uri` | bunker URI field |
| `.nostr-signer__input--relays` | relays field (nostrconnect) |
| `.nostr-signer__qr` | QR display wrapper |
| `.nostr-signer__qr-canvas` | QR canvas element |
| `.nostr-signer__qr-uri` | textual nostrconnect URI |
| `.nostr-signer__button` | base button |
| `.nostr-signer__button--primary` | primary button |
| `.nostr-signer__button--secondary` | secondary button |
| `.nostr-signer__button--submit` | submit button |
| `.nostr-signer__button--cancel` | cancel button |
| `.nostr-signer__error` | error message |
| `.nostr-signer__status` | status / loading message |
| `.nostr-signer__hint` | hint text |
