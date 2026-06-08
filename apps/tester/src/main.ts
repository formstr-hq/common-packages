import {
  createSigner,
  hexToBytes,
  type SignerEvent,
  type StoredAccount,
} from '@formstr/signer';
import {
  renderLoginHtml,
  attachLoginListeners,
  type LoginTab,
  type LoginUiBinding,
} from '@formstr/signer/ui';
import '@formstr/signer/styles.css';
import { Capacitor } from '@capacitor/core';
import { SimplePool } from 'nostr-tools';

async function resolveAndroidPlugin() {
  if (Capacitor.getPlatform() !== 'android') return undefined;
  const { NostrSignerPlugin } = await import('nostr-signer-capacitor-plugin');
  return NostrSignerPlugin;
}

const signer = createSigner({
  appName: 'signer-tester',
  androidSignerPlugin: await resolveAndroidPlugin(),
});
const pool = new SimplePool();

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const header = $<HTMLElement>('app-header');
const compose = $<HTMLElement>('compose');
const postContent = $<HTMLTextAreaElement>('post-content');
const postRelays = $<HTMLInputElement>('post-relays');
const postBtn = $<HTMLButtonElement>('post-btn');
const postStatus = $<HTMLDivElement>('post-status');
const postOutput = $<HTMLPreElement>('post-output');
const eventLog = $<HTMLUListElement>('event-log');
const modalRoot = $<HTMLDivElement>('login-modal');

let switcherOpen = false;
let modalBinding: LoginUiBinding | null = null;

function shortNpub(npub: string): string {
  return `${npub.slice(0, 12)}…${npub.slice(-6)}`;
}

function methodLabel(method: StoredAccount['method']): string {
  switch (method) {
    case 'ncryptsec':
      return 'encrypted key';
    case 'extension':
      return 'extension';
    case 'nip46':
      return 'remote signer';
    case 'android':
      return 'android signer';
  }
}

function closeModal(): void {
  modalBinding?.detach();
  modalBinding = null;
  modalRoot.innerHTML = '';
  modalRoot.hidden = true;
}

function openLoginModal(options: {
  defaultTab?: LoginTab;
  prefillNcryptsec?: string;
} = {}): void {
  closeModal();
  modalRoot.innerHTML = renderLoginHtml();
  modalRoot.hidden = false;
  if (options.prefillNcryptsec) {
    const input = modalRoot.querySelector<HTMLTextAreaElement>(
      '.nostr-signer__input--ncryptsec',
    );
    if (input) input.value = options.prefillNcryptsec;
  }
  modalBinding = attachLoginListeners(modalRoot, signer, {
    defaultTab: options.defaultTab,
    pool,
    onLogin: () => closeModal(),
    onCancel: () => closeModal(),
  });
}

async function unlockActive(): Promise<void> {
  const account = signer.getActiveAccount();
  if (!account) return;
  try {
    switch (account.method) {
      case 'ncryptsec':
        openLoginModal({
          defaultTab: 'ncryptsec',
          prefillNcryptsec: account.ncryptsec,
        });
        return;
      case 'extension':
        await signer.loginWithExtension();
        return;
      case 'nip46':
        if (!account.nip46) return;
        await signer.loginWithBunkerUri(account.nip46.uri, {
          pool,
          clientSecretKey: hexToBytes(account.nip46.clientSecretKey),
        });
        return;
      case 'android':
        await signer.loginWithAndroidSigner({
          packageName: account.androidPackageName,
        });
        return;
    }
  } catch (err) {
    appendLog(`unlock failed: ${(err as Error).message}`, 'danger');
  }
}

function renderHeader(): void {
  const active = signer.getActiveAccount();
  const activeSigner = signer.getActiveSigner();
  const accounts = signer.listAccounts();

  if (!active) {
    header.innerHTML = `
      <h1>@formstr/signer tester</h1>
      <span style="flex: 1"></span>
      <button class="app__btn app__btn--primary" data-action="signin">Sign in</button>
    `;
    header
      .querySelector<HTMLButtonElement>('[data-action="signin"]')!
      .addEventListener('click', () => openLoginModal());
    return;
  }

  const stateLabel = activeSigner
    ? `<span class="ok">unlocked</span>`
    : `<span class="danger">locked</span>`;
  const otherAccounts = accounts.filter((a) => a.pubkey !== active.pubkey);
  const accountItems = accounts
    .map((a) => {
      const isActive = a.pubkey === active.pubkey;
      return `
        <li class="switcher__item ${isActive ? 'switcher__item--active' : ''}" data-pubkey="${a.pubkey}">
          <code>${shortNpub(a.npub)}</code>
          <span class="muted">${methodLabel(a.method)}</span>
          ${isActive ? '<span class="muted">active</span>' : ''}
          <button class="switcher__item-remove" data-action="remove" data-pubkey="${a.pubkey}" aria-label="Remove">&times;</button>
        </li>
      `;
    })
    .join('');

  header.innerHTML = `
    <h1>@formstr/signer tester</h1>
    <div class="app__active">
      <div class="switcher">
        <button class="app__btn" data-action="toggle-switcher">
          <code>${shortNpub(active.npub)}</code> &#9662;
        </button>
        <div class="switcher__menu" ${switcherOpen ? '' : 'hidden'} data-region="switcher-menu">
          <ul>${accountItems}</ul>
          ${otherAccounts.length > 0 ? '' : ''}
          <div class="switcher__add" data-action="add-account">+ Add another account</div>
        </div>
      </div>
      <div class="app__active-info">
        <span class="muted">${methodLabel(active.method)} · ${stateLabel}</span>
      </div>
    </div>
    ${activeSigner ? '' : '<button class="app__btn app__btn--primary" data-action="unlock">Unlock</button>'}
    <button class="app__btn app__btn--danger" data-action="logout">Logout</button>
  `;

  header
    .querySelector<HTMLButtonElement>('[data-action="toggle-switcher"]')!
    .addEventListener('click', (e) => {
      e.stopPropagation();
      switcherOpen = !switcherOpen;
      renderHeader();
    });

  header
    .querySelector<HTMLDivElement>('[data-action="add-account"]')!
    .addEventListener('click', () => {
      switcherOpen = false;
      openLoginModal();
    });

  header.querySelectorAll<HTMLLIElement>('.switcher__item').forEach((item) => {
    item.addEventListener('click', async (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-action="remove"]')) return;
      const pubkey = item.dataset.pubkey!;
      if (pubkey === active.pubkey) return;
      switcherOpen = false;
      await signer.switchAccount(pubkey);
    });
  });

  header
    .querySelectorAll<HTMLButtonElement>('[data-action="remove"]')
    .forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const pubkey = btn.dataset.pubkey!;
        await signer.logout(pubkey);
      });
    });

  const unlockBtn = header.querySelector<HTMLButtonElement>('[data-action="unlock"]');
  if (unlockBtn) unlockBtn.addEventListener('click', () => unlockActive());

  header
    .querySelector<HTMLButtonElement>('[data-action="logout"]')!
    .addEventListener('click', () => signer.logout());
}

function renderCompose(): void {
  const activeSigner = signer.getActiveSigner();
  compose.classList.toggle('compose__disabled', !activeSigner);
  postBtn.disabled = !activeSigner;
}

function appendLog(message: string, klass: 'muted' | 'ok' | 'danger' = 'muted'): void {
  const first = eventLog.firstElementChild;
  if (first?.textContent === 'no events yet') eventLog.innerHTML = '';
  const li = document.createElement('li');
  li.className = `log__item ${klass}`;
  const stamp = new Date().toLocaleTimeString();
  li.innerHTML = `<code>${stamp}</code> ${message}`;
  eventLog.prepend(li);
}

function describeEvent(event: SignerEvent): string {
  if (event.type === 'logout') return `logout ${event.pubkey.slice(0, 8)}…`;
  return `${event.type} ${shortNpub(event.account.npub)}`;
}

document.addEventListener('click', (e) => {
  if (!switcherOpen) return;
  const menu = header.querySelector('[data-region="switcher-menu"]');
  const toggle = header.querySelector('[data-action="toggle-switcher"]');
  const target = e.target as Node;
  if (menu?.contains(target) || toggle?.contains(target)) return;
  switcherOpen = false;
  renderHeader();
});

postBtn.addEventListener('click', async () => {
  postOutput.hidden = true;
  postStatus.hidden = true;
  const active = signer.getActiveSigner();
  if (!active) return;
  try {
    const event = await active.signEvent({
      kind: 1,
      content: postContent.value,
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    postOutput.hidden = false;
    postOutput.textContent = JSON.stringify(event, null, 2);
    appendLog(`signed kind 1 — id ${event.id.slice(0, 8)}…`, 'ok');

    const relays = postRelays.value
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean);
    if (relays.length === 0) {
      postStatus.hidden = false;
      postStatus.className = 'muted';
      postStatus.textContent = 'Signed only — no relays provided.';
      return;
    }
    postStatus.hidden = false;
    postStatus.className = 'muted';
    postStatus.textContent = `Publishing to ${relays.length} relay(s)…`;
    const results = await Promise.allSettled(pool.publish(relays, event));
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    postStatus.className = failed ? 'danger' : 'ok';
    postStatus.textContent = `Accepted by ${ok}/${results.length} relays${failed ? ` (${failed} rejected)` : ''}.`;
    appendLog(`published to ${ok}/${results.length} relays`, failed ? 'danger' : 'ok');
  } catch (err) {
    postStatus.hidden = false;
    postStatus.className = 'danger';
    postStatus.textContent = (err as Error).message;
  }
});

signer.onChange((event) => {
  appendLog(describeEvent(event), event.type === 'logout' ? 'muted' : 'ok');
  renderHeader();
  renderCompose();
});

renderHeader();
renderCompose();
