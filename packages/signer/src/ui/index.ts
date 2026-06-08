import QRCode from 'qrcode';
import type { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import type { Signer } from '../core/signer.js';
import type { RelayMismatchHandler, StoredAccount } from '../core/types.js';

export type LoginTab = 'create' | 'ncryptsec' | 'extension' | 'bunker' | 'nostrconnect' | 'android';

export interface LoginUiHandlers {
  onLogin?: (account: StoredAccount) => void;
  onCancel?: () => void;
  onError?: (error: Error) => void;
  /** Optional: passed through to NIP-46 login methods. */
  pool?: AbstractSimplePool;
  /** Optional: passed through to NIP-46 login methods. */
  onRelayMismatch?: RelayMismatchHandler;
  /** Initial tab to show. Defaults to 'create'. */
  defaultTab?: LoginTab;
}

export interface LoginUiBinding {
  detach(): void;
  selectTab(tab: LoginTab): void;
}

const TABS: ReadonlyArray<{ id: LoginTab; label: string }> = [
  { id: 'create', label: 'Create' },
  { id: 'ncryptsec', label: 'Existing key' },
  { id: 'extension', label: 'Extension' },
  { id: 'bunker', label: 'Bunker URI' },
  { id: 'nostrconnect', label: 'Remote (QR)' },
  { id: 'android', label: 'Android' },
];

export function renderLoginHtml(): string {
  const tabs = TABS.map(
    (t) =>
      `<button class="nostr-signer__tab nostr-signer__tab--${t.id}" type="button" data-tab="${t.id}">${t.label}</button>`,
  ).join('');

  return `<div class="nostr-signer__root">
  <div class="nostr-signer__modal">
    <header class="nostr-signer__header">
      <h2 class="nostr-signer__title">Sign in</h2>
      <button class="nostr-signer__close" type="button" data-action="cancel" aria-label="Close">&times;</button>
    </header>
    <nav class="nostr-signer__tabs" role="tablist">${tabs}</nav>
    <main class="nostr-signer__body">
      <section class="nostr-signer__panel nostr-signer__panel--create" data-panel="create">
        <p class="nostr-signer__hint">Generate a new nsec encrypted with your passphrase (NIP-49). Back up the ncryptsec on the next step — it's the only way back in.</p>
        <form class="nostr-signer__form" data-form="create">
          <label class="nostr-signer__label" for="nostr-signer-create-passphrase">Passphrase</label>
          <input class="nostr-signer__input nostr-signer__input--passphrase" id="nostr-signer-create-passphrase" type="password" name="passphrase" autocomplete="new-password" required>
          <button class="nostr-signer__button nostr-signer__button--primary" type="submit">Create account</button>
        </form>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--ncryptsec" data-panel="ncryptsec" hidden>
        <form class="nostr-signer__form" data-form="ncryptsec">
          <label class="nostr-signer__label" for="nostr-signer-ncryptsec">ncryptsec1...</label>
          <textarea class="nostr-signer__input nostr-signer__input--ncryptsec" id="nostr-signer-ncryptsec" name="ncryptsec" required></textarea>
          <label class="nostr-signer__label" for="nostr-signer-ncryptsec-passphrase">Passphrase</label>
          <input class="nostr-signer__input nostr-signer__input--passphrase" id="nostr-signer-ncryptsec-passphrase" type="password" name="passphrase" autocomplete="current-password" required>
          <button class="nostr-signer__button nostr-signer__button--primary" type="submit">Sign in</button>
        </form>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--extension" data-panel="extension" hidden>
        <p class="nostr-signer__hint">Requires a NIP-07 browser extension (nos2x, Alby, etc.).</p>
        <button class="nostr-signer__button nostr-signer__button--primary" type="button" data-action="extension-login">Sign in with extension</button>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--bunker" data-panel="bunker" hidden>
        <form class="nostr-signer__form" data-form="bunker">
          <label class="nostr-signer__label" for="nostr-signer-bunker-uri">bunker:// URI</label>
          <textarea class="nostr-signer__input nostr-signer__input--bunker-uri" id="nostr-signer-bunker-uri" name="uri" placeholder="bunker://&lt;pubkey&gt;?relay=wss://..." required></textarea>
          <label class="nostr-signer__label" for="nostr-signer-bunker-perms">Permissions (optional, comma-separated)</label>
          <input class="nostr-signer__input nostr-signer__input--perms" id="nostr-signer-bunker-perms" name="perms" placeholder="sign_event:1, nip44_encrypt">
          <button class="nostr-signer__button nostr-signer__button--primary" type="submit">Connect</button>
        </form>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--nostrconnect" data-panel="nostrconnect" hidden>
        <form class="nostr-signer__form" data-form="nostrconnect">
          <label class="nostr-signer__label" for="nostr-signer-nc-relays">Relays (comma-separated)</label>
          <input class="nostr-signer__input nostr-signer__input--relays" id="nostr-signer-nc-relays" name="relays" placeholder="wss://relay.example, wss://other" required>
          <label class="nostr-signer__label" for="nostr-signer-nc-perms">Permissions (optional, comma-separated)</label>
          <input class="nostr-signer__input nostr-signer__input--perms" id="nostr-signer-nc-perms" name="perms" placeholder="sign_event:1, nip44_encrypt">
          <button class="nostr-signer__button nostr-signer__button--primary" type="submit">Generate URI</button>
        </form>
        <div class="nostr-signer__qr" data-region="nostrconnect-qr" hidden>
          <p class="nostr-signer__hint">Scan or paste this into your remote signer:</p>
          <div class="nostr-signer__qr-image" data-region="nostrconnect-qr-image" aria-hidden="true"></div>
          <pre class="nostr-signer__qr-uri" data-region="nostrconnect-uri"></pre>
          <p class="nostr-signer__status" data-region="nostrconnect-status">Waiting for remote signer to pair...</p>
          <button class="nostr-signer__button nostr-signer__button--secondary" type="button" data-action="nostrconnect-cancel">Cancel</button>
        </div>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--android" data-panel="android" hidden>
        <p class="nostr-signer__hint">Sign in with an Android external signer app (NIP-55) such as Amber.</p>
        <p class="nostr-signer__status" data-region="android-status">Loading installed signers&hellip;</p>
        <ul class="nostr-signer__android-apps" data-region="android-apps" hidden></ul>
      </section>
      <section class="nostr-signer__panel nostr-signer__panel--created" data-panel="created" hidden>
        <p class="nostr-signer__hint">Account created. Back up this encrypted secret key — without it (and your passphrase) you cannot sign in again.</p>
        <pre class="nostr-signer__ncryptsec-display" data-region="created-ncryptsec"></pre>
        <button class="nostr-signer__button nostr-signer__button--primary" type="button" data-action="created-ack">I've backed it up</button>
      </section>
    </main>
    <div class="nostr-signer__error" data-region="error" hidden></div>
  </div>
</div>`;
}

export function attachLoginListeners(
  rootEl: HTMLElement,
  signer: Signer,
  handlers: LoginUiHandlers = {},
): LoginUiBinding {
  const detachers: Array<() => void> = [];
  let nostrConnectAbort: AbortController | null = null;

  const on = <K extends keyof HTMLElementEventMap>(
    el: Element,
    event: K,
    handler: (ev: HTMLElementEventMap[K]) => void,
  ): void => {
    const wrapped = handler as EventListener;
    el.addEventListener(event, wrapped);
    detachers.push(() => el.removeEventListener(event, wrapped));
  };

  const q = <T extends Element = Element>(selector: string): T =>
    rootEl.querySelector(selector) as T;

  const errorEl = q<HTMLDivElement>('[data-region="error"]');
  const showError = (err: Error | string): void => {
    const msg = typeof err === 'string' ? err : err.message;
    errorEl.hidden = false;
    errorEl.textContent = msg;
    if (typeof err !== 'string') handlers.onError?.(err);
  };
  const clearError = (): void => {
    errorEl.hidden = true;
    errorEl.textContent = '';
  };

  // ---- android (NIP-55) — declared before selectTab so it can be invoked
  // when the user opens with defaultTab: 'android'.
  const androidStatus = q<HTMLElement>('[data-region="android-status"]');
  const androidList = q<HTMLUListElement>('[data-region="android-apps"]');
  let androidFetchToken = 0;

  const refreshAndroidApps = async (): Promise<void> => {
    const token = ++androidFetchToken;
    androidList.hidden = true;
    androidList.innerHTML = '';
    androidStatus.hidden = false;
    androidStatus.textContent = 'Loading installed signers…';
    try {
      const apps = await signer.listAndroidSignerApps();
      if (token !== androidFetchToken) return;
      if (apps.length === 0) {
        androidStatus.textContent =
          'No NIP-55 signer apps installed. Install Amber (or similar) and try again.';
        return;
      }
      androidStatus.hidden = true;
      for (const app of apps) {
        const li = document.createElement('li');
        li.className = 'nostr-signer__android-app';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'nostr-signer__button nostr-signer__button--primary';
        btn.dataset.packageName = app.packageName;
        btn.textContent = `${app.name} (${app.packageName})`;
        on(btn, 'click', async () => {
          clearError();
          btn.disabled = true;
          try {
            const account = await signer.loginWithAndroidSigner({
              packageName: app.packageName,
            });
            handlers.onLogin?.(account);
          } catch (err) {
            btn.disabled = false;
            showError(err as Error);
          }
        });
        li.appendChild(btn);
        androidList.appendChild(li);
      }
      androidList.hidden = false;
    } catch (err) {
      if (token !== androidFetchToken) return;
      androidStatus.textContent = (err as Error).message;
    }
  };

  const selectTab = (tab: LoginTab): void => {
    rootEl.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab;
    });
    rootEl.querySelectorAll<HTMLElement>('[data-tab]').forEach((btn) => {
      btn.classList.toggle('nostr-signer__tab--active', btn.dataset.tab === tab);
    });
    clearError();
    if (tab === 'android') void refreshAndroidApps();
  };

  selectTab(handlers.defaultTab ?? 'create');

  rootEl.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    on(btn, 'click', () => selectTab(btn.dataset.tab as LoginTab));
  });

  on(q('[data-action="cancel"]'), 'click', () => handlers.onCancel?.());

  // ---- create ----
  const createForm = q<HTMLFormElement>('[data-form="create"]');
  on(createForm, 'submit', async (ev) => {
    ev.preventDefault();
    clearError();
    const passphrase = (createForm.elements.namedItem('passphrase') as HTMLInputElement).value;
    try {
      const { ncryptsec } = await signer.createAccount(passphrase);
      q<HTMLElement>('[data-region="created-ncryptsec"]').textContent = ncryptsec;
      rootEl.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => {
        p.hidden = p.dataset.panel !== 'created';
      });
    } catch (err) {
      showError(err as Error);
    }
  });

  on(q('[data-action="created-ack"]'), 'click', () => {
    const active = signer.getActiveAccount();
    if (active) handlers.onLogin?.(active);
  });

  // ---- ncryptsec ----
  const ncryptsecForm = q<HTMLFormElement>('[data-form="ncryptsec"]');
  on(ncryptsecForm, 'submit', async (ev) => {
    ev.preventDefault();
    clearError();
    const ncryptsec = (
      ncryptsecForm.elements.namedItem('ncryptsec') as HTMLTextAreaElement
    ).value.trim();
    const passphrase = (
      ncryptsecForm.elements.namedItem('passphrase') as HTMLInputElement
    ).value;
    try {
      const account = await signer.loginWithNcryptsec(ncryptsec, passphrase);
      handlers.onLogin?.(account);
    } catch (err) {
      showError(err as Error);
    }
  });

  // ---- extension ----
  on(q('[data-action="extension-login"]'), 'click', async () => {
    clearError();
    try {
      const account = await signer.loginWithExtension();
      handlers.onLogin?.(account);
    } catch (err) {
      showError(err as Error);
    }
  });

  // ---- bunker URI ----
  const bunkerForm = q<HTMLFormElement>('[data-form="bunker"]');
  on(bunkerForm, 'submit', async (ev) => {
    ev.preventDefault();
    clearError();
    const uri = (
      bunkerForm.elements.namedItem('uri') as HTMLTextAreaElement
    ).value.trim();
    const perms = (bunkerForm.elements.namedItem('perms') as HTMLInputElement).value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      const account = await signer.loginWithBunkerUri(uri, {
        pool: handlers.pool,
        onRelayMismatch: handlers.onRelayMismatch,
        perms: perms.length > 0 ? perms : undefined,
      });
      handlers.onLogin?.(account);
    } catch (err) {
      showError(err as Error);
    }
  });

  // ---- nostrconnect ----
  const ncForm = q<HTMLFormElement>('[data-form="nostrconnect"]');
  const ncQrRegion = q<HTMLDivElement>('[data-region="nostrconnect-qr"]');
  const ncQrUri = q<HTMLElement>('[data-region="nostrconnect-uri"]');
  const ncQrImage = q<HTMLDivElement>('[data-region="nostrconnect-qr-image"]');
  const ncStatus = q<HTMLElement>('[data-region="nostrconnect-status"]');
  let ncQrToken = 0;

  const resetNostrConnect = (): void => {
    ncForm.hidden = false;
    ncQrRegion.hidden = true;
    ncQrUri.textContent = '';
    ncQrImage.innerHTML = '';
    ncStatus.textContent = 'Waiting for remote signer to pair...';
    ncQrToken++;
  };

  const renderNostrConnectQr = async (uri: string): Promise<void> => {
    const token = ++ncQrToken;
    try {
      const svg = await QRCode.toString(uri, {
        type: 'svg',
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      if (token === ncQrToken) ncQrImage.innerHTML = svg;
    } catch {
      // QR rendering is a nice-to-have — the URI text remains usable.
    }
  };

  on(ncForm, 'submit', async (ev) => {
    ev.preventDefault();
    clearError();
    const relays = (ncForm.elements.namedItem('relays') as HTMLInputElement).value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (relays.length === 0) {
      showError('At least one relay is required.');
      return;
    }
    const perms = (ncForm.elements.namedItem('perms') as HTMLInputElement).value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    ncForm.hidden = true;
    ncQrRegion.hidden = false;
    nostrConnectAbort = new AbortController();
    try {
      const account = await signer.loginWithNostrConnect({
        relays,
        perms: perms.length > 0 ? perms : undefined,
        pool: handlers.pool,
        onRelayMismatch: handlers.onRelayMismatch,
        signal: nostrConnectAbort.signal,
        onUri: (uri) => {
          ncQrUri.textContent = uri;
          void renderNostrConnectQr(uri);
        },
      });
      handlers.onLogin?.(account);
    } catch (err) {
      resetNostrConnect();
      if ((err as Error).name !== 'AbortError') showError(err as Error);
    } finally {
      nostrConnectAbort = null;
    }
  });

  on(q('[data-action="nostrconnect-cancel"]'), 'click', () => {
    nostrConnectAbort?.abort();
    resetNostrConnect();
  });

  return {
    detach: () => {
      nostrConnectAbort?.abort();
      for (const d of detachers) d();
    },
    selectTab,
  };
}
