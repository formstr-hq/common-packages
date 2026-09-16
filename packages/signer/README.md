# @formstr/signer

A vanilla TypeScript Nostr signer with an optional unstyled login UI. Supports NIP-07 (browser extension), NIP-46 (bunker URI + nostrconnect QR), NIP-49 (ncryptsec at rest), NIP-55 (Android external signer apps, via a Capacitor plugin **or** a plain browser), and a pure-web signer-app flow.

## Install

```bash
pnpm add @formstr/signer
```

## Quick start

```ts
import { createSigner } from '@formstr/signer';

// `appName` is required if you plan to use nostrconnect (NIP-46 QR flow) —
// see "NIP-46 app identity" below. Other login methods don't depend on it.
const signer = createSigner({ appName: 'my-app' });

// Create a new account (NIP-49 ncryptsec encrypted at rest)
const { npub, ncryptsec } = await signer.createAccount('my-passphrase');

// Subsequent sessions: log in with the encrypted nsec
await signer.loginWithNcryptsec(ncryptsec, 'my-passphrase');

// Or any of the other methods
await signer.loginWithExtension();
await signer.loginWithBunkerUri('bunker://...');
await signer.loginWithNostrConnect({ relays: ['wss://relay.example'], onUri: (uri) => /* show QR */ });
await signer.loginWithAndroidSigner({ packageName: 'com.greenart7c3.nostrsigner' });
await signer.loginWithNip55Web(); // Android browser, no Capacitor shell — see below

// Sign events — the active signer never exposes the privkey
const active = signer.getActiveSigner()!;
const signed = await active.signEvent({ kind: 1, content: 'gm', tags: [], created_at: 0 });
```

## Account model

A `StoredAccount` is the persisted record for one identity. Accounts survive page reloads via the configured `StorageAdapter`. Listing, switching, and removing are independent of unlock state.

```ts
signer.listAccounts();          // every persisted account
signer.getActiveAccount();      // currently selected — present even when locked
signer.getActiveSigner();       // unlocked signer — null until re-auth
await signer.switchAccount(pubkey);
await signer.logout(pubkey);    // pubkey defaults to active

const unsub = signer.onChange((ev) => {
  // ev.type is 'login' | 'switch' | 'logout'
});
```

## Hydration & locked state

The single most important thing to understand about this package: **after a fresh page load, every account starts locked**. That means:

- `listAccounts()` returns the saved accounts.
- `getActiveAccount()` returns the account that was active before reload.
- `getActiveSigner()` returns **`null`**, regardless of method.

### `unlock()` — silent rehydration

For every method except `ncryptsec`, the package has enough persisted state to rebuild the runtime signer without prompting anyone — `unlock()` is the way to actually do that on cold start:

```ts
const signer = createSigner({ androidSignerPlugin, /* ... */ });
const active = await signer.unlock({ pool });   // pool only needed for nip46
if (active) {
  // signed-in user — proceed
} else {
  // either no active account, or method='ncryptsec' (drive the passphrase prompt yourself)
}
```

Per-method behavior:

| Method | What `unlock()` does | Prompt on cold start? |
| --- | --- | --- |
| `extension` | constructs `ExtensionSigner` (stateless wrapper around `window.nostr`) | no |
| `nip46` | reuses persisted `clientSecretKey` + `remoteSignerPubkey` + `relays` to attach a `BunkerSigner` — **skips the `connect` request**, which is what triggers a fresh approval prompt every reload | no |
| `android` | builds the `AndroidSigner` directly from cached `pubkey` + `npub` + `androidPackageName`, **bypassing the plugin's `getPublicKey` content-provider call** | no |
| `nip55-web` | builds a `Nip55WebSigner` from the cached `pubkey`; it does not open the signer app until the next sign/encrypt call | no |
| `ncryptsec` | returns `null` — the passphrase is not (and must not be) persisted; caller drives the prompt and calls `loginWithNcryptsec(account.ncryptsec, passphrase)` | n/a (by design) |

`unlock()` returns `null` (without emitting an event) when there is no active account, when the account is missing fields it needs to resume, when method is `nip46` but no `pool` was supplied, or when method is `android` but no plugin is configured. On success it emits the same `login`/`switch` event the corresponding `loginWith*` would.

`getPublicKey()` after a successful nip46 unlock is a memory read, not a bunker roundtrip — the cached pubkey is wired into the `BunkerSigner` wrapper so a subsequent call needs no network.

### Why not just re-call `loginWith*`?

You still can. The difference is that the `loginWith*` methods are *first-time pairing* flows — `loginWithBunkerUri` re-sends the `connect` request, `loginWithAndroidSigner` re-queries the external signer for the pubkey — and on signer apps like Amber both of those surface as a permission prompt the user has to approve again. `unlock()` is the resume path: same end state (an active `ActiveSigner`), without re-pairing.

For ncryptsec, `unlock()` returning `null` is the signal to drive the passphrase prompt and call `loginWithNcryptsec(account.ncryptsec, passphrase)` — that's the only method with no silent path, by design.

The pattern in the UI is: **always render off `getActiveAccount()`, gate signing on `getActiveSigner()`**. Show "logged in as @alice" plus an "Unlock" button when the signer is null.

## The `ActiveSigner` contract

Every unlock path produces an `ActiveSigner`. The interface is intentionally small:

```ts
interface ActiveSigner {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<NostrEvent>;
  nip04Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
  nip44Encrypt(peerPubkey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPubkey: string, ciphertext: string): Promise<string>;
}
```

- `signEvent` accepts an `EventTemplate` (no `pubkey`/`id`/`sig`); the implementation fills those in and returns a fully-signed event.
- `peerPubkey` is the counterparty's 32-byte x-only hex pubkey.
- **There is no `getPrivateKey()`.** That omission is the package's central security invariant — the raw key is unreachable through this surface, even for the local-key signer.

Building a custom signer (hardware wallet, MPC, browser-stored hot wallet) is a matter of conforming to this interface. The package does not currently expose a way to register a custom signer type into a `StoredAccount`; you'd hold the instance yourself and pass it into your event-signing path directly.

## NIP-55 (Android) custom plugins

The default expectation is that you pass [`nostr-signer-capacitor-plugin`](https://www.npmjs.com/package/nostr-signer-capacitor-plugin) as `androidSignerPlugin`. To plug in a different implementation, conform to `AndroidSignerPlugin`:

```ts
import type { AndroidSignerPlugin } from '@formstr/signer';

const myPlugin: AndroidSignerPlugin = {
  setPackageName(packageName) { /* ... */ },
  getInstalledSignerApps() { /* ... */ },
  getPublicKey(packageName, permissions) { /* ... */ },
  signEvent(packageName, eventJson, id, npub) { /* ... */ },
  nip04Encrypt(packageName, plainText, id, pubKey, npub) { /* ... */ },
  // nip04Decrypt, nip44Encrypt, nip44Decrypt likewise
};
```

The interface signatures intentionally mirror `nostr-signer-capacitor-plugin`'s exported `NostrSignerPlugin` so the real wrapper is directly assignable. If you write a custom plugin, the package's test suite includes a compile-time conformance guard (`tests/helpers/mockAndroidPlugin.ts`) you can model your own check on — wire it up in your CI and you'll catch any drift the moment the upstream wrapper changes shape.

**Identifier shape.** The `npub` field returned by `getPublicKey` is permissive: the package accepts either a bech32 `npub1…` string (the NIP-55 spec shape) or a 32-byte hex pubkey (what current Amber builds actually return). Whichever you hand back, the package normalizes internally — `StoredAccount.npub` is always bech32 and `StoredAccount.pubkey` is always lowercase hex. Anything else surfaces as a debuggable error including a preview of what was received. The same normalization (plus `nprofile1…`) is shared with the browser flow below.

## NIP-55 in a plain browser (`loginWithNip55Web`)

The Capacitor plugin above only works inside a native Android shell. `loginWithNip55Web()` covers the other case: a **plain browser on Android** (mobile web, a PWA) talking to any installed NIP-55 signer app with no native bridge.

```ts
await signer.loginWithNip55Web();
```

The mechanism:

1. **Plant a sentinel.** The package overwrites the clipboard with a random `__formstr_nip55_sentinel_…__` string. This is what makes the result identifiable — otherwise a clipboard left over from an earlier approval would look like a fresh answer and resolve immediately.
2. **Open the intent.** It opens `intent:#Intent;scheme=nostrsigner;S.type=…;end` via `window.open`. No package is named, so Android resolves it against every app that registered the scheme — one signer opens directly, several show the standard "Open with" chooser. This is not Amber-specific.
3. **Poll the clipboard.** The signer app signs and copies the result to the clipboard. The package polls `navigator.clipboard.readText()` every `pollIntervalMs` (default 500ms) until the value differs from the sentinel, then resolves.

### Why polling, not `visibilitychange`

The obvious design — read the clipboard when the user returns to the tab — **does not work on Android Chrome**, verified on a Pixel emulator running Amber 6.6.4:

- Returning from the signer app fires **no** `visibilitychange` or `focus` event. `window.open` produces a brief hide/show blip *before* the signer is even open (a `blur`, two `visibilitychange`s and a `focus` within ~400ms), and then nothing on the actual return. An event-driven read therefore never runs.
- Even when a read is attempted right after returning, Chrome rejects it with `NotAllowedError: Document is not focused` — the page is visible but not focused, and it does not regain focus on its own.
- `setInterval`, by contrast, keeps ticking while the tab is backgrounded, so polling observes the result regardless.

This is why the transport interface has `readClipboard`/`writeClipboard` but no foreground callback: the browser simply does not provide a reliable return signal.

### Browser only — not for native builds

This flow is for a plain browser. Inside a Capacitor native shell the same
device already has the real NIP-55 plugin, which supports every method and
needs neither the clipboard nor a per-operation approval — so this path is
hidden there (Capacitor injects a `Capacitor.isNativePlatform()` global,
which the package checks without depending on `@capacitor/core`).

Gate your UI on `signer.nip55WebSupport()`:

```ts
container.innerHTML = renderLoginHtml({
  nip55Web: signer.nip55WebSupport(),
});
```

That returns `{ visible, warning?, reason? }`:

| Environment | `visible` | `warning` |
| --- | --- | --- |
| Android Chrome / Brave | `true` | — |
| Android Firefox / Focus / Klar | `true` | "May not work in Firefox for Android…" |
| Capacitor native shell | `false` | — |
| Desktop / iOS | `false` | — |

Nothing is hard-blocked: Firefox is shown **with a warning** so users can
still try, and so they can see why their browser differs from Chrome on the
same device. `loginWithNip55Web()` in a native build throws a message
pointing at `loginWithAndroidSigner()`.

`supportsNip55Web()` remains as a boolean shorthand for `.visible`.
Both are **capability** checks, not availability ones: there is no web API
to detect an installed Android app, so they cannot tell you whether a signer
app is actually present. They answer "could this flow possibly work here",
not "will it succeed".

### Firefox for Android

Firefox (and Focus/Klar) is the one browser that advertises
`navigator.clipboard.readText` yet cannot run this flow. It never grants a
persistent `clipboard-read` permission, so **every** read requires transient
user activation and is answered with an ephemeral "Paste" menu. A background
poll therefore cannot succeed.

Verified on an emulator (Firefox 125): calling `readText()` directly inside a
click handler — `hasFocus=true`, `visibilityState=visible`,
`userActivation.isActive=true` — still rejects with
`NotAllowedError: Clipboard read operation is not allowed`.

Because browser behaviour changes and blocking a whole browser is a worse
failure than a warning, the option stays visible and attemptable there.

### What to know

- **Android + secure context only.** `nip55WebSupport().visible` requires an Android user agent, the async clipboard API, and not being in a native shell. `loginWithNip55Web()` throws before persisting anything when not visible. `http://localhost` counts as a secure context, which is handy for local testing.
- **Chrome will ask to read the clipboard** the first time; approve it, or every read fails.
- **One approval per operation.** There is no background channel, so `getPublicKey`, every `signEvent`, and every `nip04`/`nip44` call re-opens the app. `unlock()` resumes the account from its cached pubkey without opening the app; the first real signing call prompts.
- **No rejection signal, but there is a timeout.** NIP-55's reject path is an Android intent extra a browser never sees, so a denial is indistinguishable from the user never returning. The package therefore times requests out (`timeoutMs`, default 120s; `0` disables) and rejects with a clear message. Pass a `signal` to cancel yourself — aborting rejects with `name === 'AbortError'`, matching the NIP-46 flow.
- **Signatures are verified.** `signEvent` computes the event id, sends the complete unsigned event, then checks the returned 128-char hex signature with `verifyEvent` before returning it.
- **The clipboard is clobbered** by the sentinel write. This is inherent to the transport; warn users if your app cares about clipboard contents.
- **Prefer NIP-46 when you can.** The NIP-55 spec itself recommends NIP-46 for web clients precisely because this flow can't run in the background. Keep the browser NIP-55 path for users who want their existing signer app without a pairing step.

The environment bridge is pluggable for tests and unusual hosts:

```ts
import type { Nip55WebTransport } from '@formstr/signer';

const s = createSigner({ nip55WebTransport: myTransport });
// or per call:
await s.loginWithNip55Web({ transport: myTransport });
```

`browserNip55Transport()` is exported as the default implementation. `pollIntervalMs` (default 500) trades latency against how often the clipboard is read. `Nip55WebSigner` also exposes a `close()` that cancels an in-flight request and stops its poll; `Signer` calls it automatically when the active signer is replaced (a new login/unlock, `switchAccount`, or `logout`), so a pending request never leaks past its session.

## NIP-46 app identity (required for nostrconnect)

The nostrconnect URI you generate must include a `name` (and ideally `url`/`image`) so remote signer apps can show the user *which app* is asking to pair. Without it:

- **Amber** receives the request but never surfaces an approve/deny prompt — the consent UI requires a recognizable client identity. The pairing silently stalls.
- Other signers will at minimum display a shortened pubkey hex instead of your app name.

The package enforces this at runtime — `loginWithNostrConnect()` throws if no name can be resolved:

```
@formstr/signer: loginWithNostrConnect requires an app name. Set `appName` in createSigner() or pass `metadata.name` to loginWithNostrConnect().
```

Two ways to supply it. Set once at construction (recommended for most apps):

```ts
const signer = createSigner({
  appName: 'my-app',
  appUrl: 'https://my-app.example',           // optional
  appImage: 'https://my-app.example/icon.png', // optional
});
await signer.loginWithNostrConnect({ relays: ['wss://...'], onUri });
```

Or override per call:

```ts
await signer.loginWithNostrConnect({
  relays: ['wss://...'],
  onUri,
  metadata: { name: 'temporary-name', url: '...', image: '...' },
});
```

Per-call `metadata.*` fields override config defaults field-by-field — set `metadata.name` without `metadata.url`, and the config's `appUrl` still applies.

The bunker:// flow (`loginWithBunkerUri`) is unaffected — NIP-46 has no spec slot for client metadata in that flow, and Amber recognizes apps via the secret embedded in the bunker URI it generated. App name shown there comes from what the user named the connection inside Amber.

## UI helpers

The UI module returns HTML strings. The calling code injects the markup wherever it wants and then calls `attach*Listeners()` to wire events.

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

The login modal renders one tab per method (Create, Existing key, Extension, Bunker URI, Remote QR, Signer app, Android). The Android tab is always rendered but its list of installed signers is fetched lazily on activation via `signer.listAndroidSignerApps()` — it errors clearly if no Android plugin is configured (e.g. when running on web). The Signer app tab drives `loginWithNip55Web()` and needs no plugin; pass `renderLoginHtml({ nip55Web: signer.nip55WebSupport() })` to hide it in native builds and to show Firefox's warning.

## Errors

All `loginWith*` methods reject with bare `Error` instances. Categories you can expect:

- **Validation** — empty passphrase, empty relays, malformed bunker URI.
- **Wrong credential** — `loginWithNcryptsec` with a bad passphrase throws synchronously after decrypt.
- **External denial** — extension/bunker/Android signer rejects the request. The browser NIP-55 flow has no denial signal (see its section), so pair it with a timeout.
- **Transport** — NIP-46 relay unreachable, pairing timeout, abort; browser NIP-55 empty/inaccessible clipboard, or an unverifiable signature.
- **Configuration** —
  - `loginWithNostrConnect` throws if neither `appName` (in `createSigner`) nor `metadata.name` (per call) is set. See "NIP-46 app identity" above.
  - `loginWithAndroidSigner` / `listAndroidSignerApps` throws if no plugin is configured.
  - `loginWithNip55Web` throws if the environment is not an Android browser with clipboard access.

Error messages are prefixed with `@formstr/signer:` for messages the package generates itself. Errors from `nostr-tools` or the Capacitor plugin propagate unchanged. There is currently no typed `code` field — discriminate by string match or by which method threw.

## Security model

- **Identity nsec at rest:** always encrypted with the user's passphrase (NIP-49). Account creation always requires a passphrase — there is no "guest" raw-nsec path.
- **Decrypted privkey:** held in memory only, for the lifetime of the page. Never written to `localStorage` or `sessionStorage`. Lost on page reload — the user re-enters the passphrase.
- **Active signer interface:** exposes `signEvent`, `nip04*`, `nip44*`, `getPublicKey` only. There is no method that returns the raw private key.
- **NIP-46 relays:** for bunker URIs, relays come from the URI. For the nostrconnect QR flow, the UI prompts the user for relays. There is no hardcoded fallback relay list.
- **NIP-46 client secret:** the per-account ephemeral keypair used to talk to the remote signer is stored in plaintext in the configured storage adapter. This is a deliberate tradeoff — see the threat-model note below.

### Threat-model note on the NIP-46 client secret

The client secret is *not* the user's identity key — it is a disposable session key the remote signer recognizes as the client. An attacker with same-origin storage access could impersonate the client to the remote signer; whether that results in unauthorized signatures depends on whether the user has granted blanket permissions on the bunker side (out of our control). Encrypting this secret with a derivable key would not defend against same-origin XSS (the realistic attacker), so we keep it plaintext rather than adding security theater.

## BEM class catalog

The UI ships with these class names. Override in your own CSS.

### Layout

| Class | Purpose |
| --- | --- |
| `.nostr-signer__root` | top-level wrapper |
| `.nostr-signer__modal` | modal box |
| `.nostr-signer__header` | header bar |
| `.nostr-signer__title` | heading text |
| `.nostr-signer__close` | close button |
| `.nostr-signer__body` | scroll region containing the panels |

### Tabs

| Class | Purpose |
| --- | --- |
| `.nostr-signer__tabs` | tab bar |
| `.nostr-signer__tab` | a tab button |
| `.nostr-signer__tab--active` | currently selected tab |
| `.nostr-signer__tab--create` | Create-account tab |
| `.nostr-signer__tab--ncryptsec` | NIP-49 ncryptsec tab |
| `.nostr-signer__tab--extension` | NIP-07 tab |
| `.nostr-signer__tab--bunker` | NIP-46 bunker URI tab |
| `.nostr-signer__tab--nostrconnect` | NIP-46 nostrconnect (QR) tab |
| `.nostr-signer__tab--nip55web` | NIP-55 browser/`nostrsigner` tab |
| `.nostr-signer__tab--android` | NIP-55 Android tab |

### Panels

| Class | Purpose |
| --- | --- |
| `.nostr-signer__panel` | base panel |
| `.nostr-signer__panel--create` | create-account panel |
| `.nostr-signer__panel--ncryptsec` | ncryptsec panel |
| `.nostr-signer__panel--extension` | extension panel |
| `.nostr-signer__panel--bunker` | bunker URI panel |
| `.nostr-signer__panel--nostrconnect` | nostrconnect panel |
| `.nostr-signer__panel--nip55web` | NIP-55 browser/`nostrsigner` panel |
| `.nostr-signer__panel--android` | Android signer panel |
| `.nostr-signer__panel--created` | post-creation backup-the-ncryptsec panel |

### Forms / inputs

| Class | Purpose |
| --- | --- |
| `.nostr-signer__form` | form wrapper |
| `.nostr-signer__label` | input label |
| `.nostr-signer__input` | text input base |
| `.nostr-signer__input--passphrase` | passphrase field |
| `.nostr-signer__input--ncryptsec` | ncryptsec textarea |
| `.nostr-signer__input--bunker-uri` | bunker URI textarea |
| `.nostr-signer__input--relays` | relays field (nostrconnect) |
| `.nostr-signer__input--perms` | permissions field (nostrconnect) |
| `.nostr-signer__ncryptsec-display` | post-creation ncryptsec display |

### Android signer list

| Class | Purpose |
| --- | --- |
| `.nostr-signer__android-apps` | list of installed signer apps |
| `.nostr-signer__android-app` | one signer in the list |

### QR

| Class | Purpose |
| --- | --- |
| `.nostr-signer__qr` | QR display wrapper |
| `.nostr-signer__qr-uri` | textual nostrconnect URI |

### Buttons / status

| Class | Purpose |
| --- | --- |
| `.nostr-signer__button` | base button |
| `.nostr-signer__button--primary` | primary button |
| `.nostr-signer__button--secondary` | secondary button |
| `.nostr-signer__error` | error message |
| `.nostr-signer__warn` | advisory (non-blocking) warning |
| `.nostr-signer__status` | status / loading message |
| `.nostr-signer__hint` | hint text |
