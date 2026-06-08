// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderLoginHtml, attachLoginListeners } from '../src/ui/index.js';
import type { Signer } from '../src/core/signer.js';
import type { StoredAccount } from '../src/core/types.js';

interface MockSigner {
  createAccount: ReturnType<typeof vi.fn>;
  loginWithExtension: ReturnType<typeof vi.fn>;
  loginWithNcryptsec: ReturnType<typeof vi.fn>;
  loginWithBunkerUri: ReturnType<typeof vi.fn>;
  loginWithNostrConnect: ReturnType<typeof vi.fn>;
  loginWithAndroidSigner: ReturnType<typeof vi.fn>;
  getActiveAccount: ReturnType<typeof vi.fn>;
}

function makeSignerStub(): MockSigner {
  return {
    createAccount: vi.fn(),
    loginWithExtension: vi.fn(),
    loginWithNcryptsec: vi.fn(),
    loginWithBunkerUri: vi.fn(),
    loginWithNostrConnect: vi.fn(),
    loginWithAndroidSigner: vi.fn(),
    getActiveAccount: vi.fn(),
  };
}

function asSigner(stub: MockSigner): Signer {
  return stub as unknown as Signer;
}

function fakeAccount(method: StoredAccount['method'] = 'ncryptsec'): StoredAccount {
  return {
    npub: 'npub1example',
    pubkey: 'ab'.repeat(32),
    method,
    ncryptsec: method === 'ncryptsec' ? 'ncryptsec1example' : undefined,
  };
}

let root: HTMLDivElement;

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  root.innerHTML = renderLoginHtml();
});

afterEach(() => {
  root.remove();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('renderLoginHtml', () => {
  it('renders all five tabs and their panels', () => {
    const tabs = root.querySelectorAll('[data-tab]');
    expect(tabs.length).toBe(5);
    const panelIds = Array.from(root.querySelectorAll<HTMLElement>('[data-panel]')).map(
      (p) => p.dataset.panel,
    );
    expect(panelIds).toEqual(
      expect.arrayContaining([
        'create',
        'ncryptsec',
        'extension',
        'bunker',
        'nostrconnect',
        'created',
      ]),
    );
  });

  it('includes the error region and the close button', () => {
    expect(root.querySelector('[data-region="error"]')).toBeTruthy();
    expect(root.querySelector('[data-action="cancel"]')).toBeTruthy();
  });
});

describe('attachLoginListeners', () => {
  it('shows the create panel by default and toggles tabs', () => {
    const signer = makeSignerStub();
    attachLoginListeners(root, asSigner(signer));
    const createPanel = root.querySelector<HTMLElement>('[data-panel="create"]')!;
    expect(createPanel.hidden).toBe(false);
    const createTab = root.querySelector<HTMLElement>('[data-tab="create"]')!;
    expect(createTab.classList.contains('nostr-signer__tab--active')).toBe(true);
  });

  it('respects the defaultTab option', () => {
    const signer = makeSignerStub();
    attachLoginListeners(root, asSigner(signer), { defaultTab: 'bunker' });
    expect(root.querySelector<HTMLElement>('[data-panel="bunker"]')!.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>('[data-panel="create"]')!.hidden).toBe(true);
  });

  it('selectTab on the binding switches panels and clears the error region', () => {
    const signer = makeSignerStub();
    const binding = attachLoginListeners(root, asSigner(signer));
    const errorEl = root.querySelector<HTMLDivElement>('[data-region="error"]')!;
    errorEl.hidden = false;
    errorEl.textContent = 'previous';
    binding.selectTab('ncryptsec');
    expect(root.querySelector<HTMLElement>('[data-panel="ncryptsec"]')!.hidden).toBe(false);
    expect(errorEl.hidden).toBe(true);
  });

  it('clicking a tab button switches panels', () => {
    const signer = makeSignerStub();
    attachLoginListeners(root, asSigner(signer));
    root.querySelector<HTMLButtonElement>('[data-tab="extension"]')!.click();
    expect(root.querySelector<HTMLElement>('[data-panel="extension"]')!.hidden).toBe(false);
  });

  it('cancel button fires onCancel', () => {
    const signer = makeSignerStub();
    const onCancel = vi.fn();
    attachLoginListeners(root, asSigner(signer), { onCancel });
    root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancel is a no-op when no onCancel handler is supplied', () => {
    const signer = makeSignerStub();
    attachLoginListeners(root, asSigner(signer));
    expect(() =>
      root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click(),
    ).not.toThrow();
  });

  describe('create flow', () => {
    it('shows the created panel with the ncryptsec after successful creation', async () => {
      const signer = makeSignerStub();
      signer.createAccount.mockResolvedValue({
        npub: 'npub1example',
        ncryptsec: 'ncryptsec1backthisup',
      });
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="create"]')!;
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = 'mypass';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.createAccount).toHaveBeenCalledWith('mypass');
      const display = root.querySelector('[data-region="created-ncryptsec"]')!;
      expect(display.textContent).toBe('ncryptsec1backthisup');
      expect(root.querySelector<HTMLElement>('[data-panel="created"]')!.hidden).toBe(false);
      expect(root.querySelector<HTMLElement>('[data-panel="create"]')!.hidden).toBe(true);
    });

    it('shows an error and stays on the create panel when creation fails', async () => {
      const signer = makeSignerStub();
      signer.createAccount.mockRejectedValue(new Error('passphrase required'));
      const onError = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onError });
      const form = root.querySelector<HTMLFormElement>('[data-form="create"]')!;
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = '';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      const errorEl = root.querySelector<HTMLDivElement>('[data-region="error"]')!;
      expect(errorEl.hidden).toBe(false);
      expect(errorEl.textContent).toContain('passphrase required');
      expect(onError).toHaveBeenCalledTimes(1);
      expect(root.querySelector<HTMLElement>('[data-panel="created"]')!.hidden).toBe(true);
    });

    it('clicking "I have backed it up" fires onLogin with the active account', async () => {
      const account = fakeAccount('ncryptsec');
      const signer = makeSignerStub();
      signer.createAccount.mockResolvedValue({ npub: account.npub, ncryptsec: 'nc' });
      signer.getActiveAccount.mockReturnValue(account);
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      const form = root.querySelector<HTMLFormElement>('[data-form="create"]')!;
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = 'p';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      root.querySelector<HTMLButtonElement>('[data-action="created-ack"]')!.click();
      expect(onLogin).toHaveBeenCalledWith(account);
    });

    it('acknowledge is a no-op when there is no active account', async () => {
      const signer = makeSignerStub();
      signer.createAccount.mockResolvedValue({ npub: 'x', ncryptsec: 'y' });
      signer.getActiveAccount.mockReturnValue(null);
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      const form = root.querySelector<HTMLFormElement>('[data-form="create"]')!;
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = 'p';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      root.querySelector<HTMLButtonElement>('[data-action="created-ack"]')!.click();
      expect(onLogin).not.toHaveBeenCalled();
    });
  });

  describe('ncryptsec flow', () => {
    it('calls loginWithNcryptsec with trimmed inputs and fires onLogin', async () => {
      const account = fakeAccount('ncryptsec');
      const signer = makeSignerStub();
      signer.loginWithNcryptsec.mockResolvedValue(account);
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      const form = root.querySelector<HTMLFormElement>('[data-form="ncryptsec"]')!;
      (form.elements.namedItem('ncryptsec') as HTMLTextAreaElement).value =
        '  ncryptsec1abc  ';
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = 'p';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.loginWithNcryptsec).toHaveBeenCalledWith('ncryptsec1abc', 'p');
      expect(onLogin).toHaveBeenCalledWith(account);
    });

    it('shows an error and does not fire onLogin when login fails', async () => {
      const signer = makeSignerStub();
      signer.loginWithNcryptsec.mockRejectedValue(new Error('bad passphrase'));
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      const form = root.querySelector<HTMLFormElement>('[data-form="ncryptsec"]')!;
      (form.elements.namedItem('ncryptsec') as HTMLTextAreaElement).value = 'x';
      (form.elements.namedItem('passphrase') as HTMLInputElement).value = 'y';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      const errorEl = root.querySelector<HTMLDivElement>('[data-region="error"]')!;
      expect(errorEl.textContent).toContain('bad passphrase');
      expect(onLogin).not.toHaveBeenCalled();
    });
  });

  describe('extension flow', () => {
    it('calls loginWithExtension and fires onLogin', async () => {
      const account = fakeAccount('extension');
      const signer = makeSignerStub();
      signer.loginWithExtension.mockResolvedValue(account);
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      root.querySelector<HTMLButtonElement>('[data-action="extension-login"]')!.click();
      await flush();
      expect(signer.loginWithExtension).toHaveBeenCalledTimes(1);
      expect(onLogin).toHaveBeenCalledWith(account);
    });

    it('shows an error when extension login fails', async () => {
      const signer = makeSignerStub();
      signer.loginWithExtension.mockRejectedValue(new Error('no extension'));
      attachLoginListeners(root, asSigner(signer));
      root.querySelector<HTMLButtonElement>('[data-action="extension-login"]')!.click();
      await flush();
      expect(
        root.querySelector<HTMLDivElement>('[data-region="error"]')!.textContent,
      ).toContain('no extension');
    });
  });

  describe('bunker URI flow', () => {
    it('passes the URI and options to loginWithBunkerUri', async () => {
      const account = fakeAccount('nip46');
      const signer = makeSignerStub();
      signer.loginWithBunkerUri.mockResolvedValue(account);
      const onRelayMismatch = vi.fn();
      const pool = {} as never;
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin, pool, onRelayMismatch });
      const form = root.querySelector<HTMLFormElement>('[data-form="bunker"]')!;
      (form.elements.namedItem('uri') as HTMLTextAreaElement).value = '  bunker://abc  ';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.loginWithBunkerUri).toHaveBeenCalledWith('bunker://abc', {
        pool,
        onRelayMismatch,
      });
      expect(onLogin).toHaveBeenCalledWith(account);
    });

    it('shows an error when bunker login fails', async () => {
      const signer = makeSignerStub();
      signer.loginWithBunkerUri.mockRejectedValue(new Error('invalid bunker URI'));
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="bunker"]')!;
      (form.elements.namedItem('uri') as HTMLTextAreaElement).value = 'bad';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(
        root.querySelector<HTMLDivElement>('[data-region="error"]')!.textContent,
      ).toContain('invalid bunker URI');
    });
  });

  describe('nostrconnect flow', () => {
    it('rejects submission with no relays', async () => {
      const signer = makeSignerStub();
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value = '   ';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.loginWithNostrConnect).not.toHaveBeenCalled();
      expect(
        root.querySelector<HTMLDivElement>('[data-region="error"]')!.textContent,
      ).toContain('At least one relay');
    });

    it('shows the URI, calls loginWithNostrConnect, and fires onLogin on success', async () => {
      const account = fakeAccount('nip46');
      const signer = makeSignerStub();
      signer.loginWithNostrConnect.mockImplementation(async (opts) => {
        opts.onUri('nostrconnect://test-uri');
        return account;
      });
      const onLogin = vi.fn();
      attachLoginListeners(root, asSigner(signer), { onLogin });
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value =
        'wss://a.test, wss://b.test';
      (form.elements.namedItem('perms') as HTMLInputElement).value =
        'sign_event:1, nip44_encrypt';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.loginWithNostrConnect).toHaveBeenCalledWith(
        expect.objectContaining({
          relays: ['wss://a.test', 'wss://b.test'],
          perms: ['sign_event:1', 'nip44_encrypt'],
        }),
      );
      expect(root.querySelector('[data-region="nostrconnect-uri"]')!.textContent).toBe(
        'nostrconnect://test-uri',
      );
      expect(onLogin).toHaveBeenCalledWith(account);
    });

    it('omits perms when the perms field is empty', async () => {
      const signer = makeSignerStub();
      signer.loginWithNostrConnect.mockResolvedValue(fakeAccount('nip46'));
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value = 'wss://a.test';
      (form.elements.namedItem('perms') as HTMLInputElement).value = '';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(signer.loginWithNostrConnect).toHaveBeenCalledWith(
        expect.objectContaining({ perms: undefined }),
      );
    });

    it('resets the form silently when the user cancels (AbortError)', async () => {
      const signer = makeSignerStub();
      signer.loginWithNostrConnect.mockImplementation(
        (opts) =>
          new Promise((_, reject) => {
            opts.signal!.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value = 'wss://a.test';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(form.hidden).toBe(true);
      root
        .querySelector<HTMLButtonElement>('[data-action="nostrconnect-cancel"]')!
        .click();
      await flush();
      expect(form.hidden).toBe(false);
      expect(
        root.querySelector<HTMLDivElement>('[data-region="error"]')!.hidden,
      ).toBe(true);
    });

    it('shows the error and resets the form when a non-abort error occurs', async () => {
      const signer = makeSignerStub();
      signer.loginWithNostrConnect.mockRejectedValue(new Error('bunker timeout'));
      attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value = 'wss://a.test';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      expect(form.hidden).toBe(false);
      expect(
        root.querySelector<HTMLDivElement>('[data-region="error"]')!.textContent,
      ).toContain('bunker timeout');
    });
  });

  describe('detach()', () => {
    it('removes listeners so subsequent clicks do nothing', () => {
      const signer = makeSignerStub();
      const onCancel = vi.fn();
      const binding = attachLoginListeners(root, asSigner(signer), { onCancel });
      binding.detach();
      root.querySelector<HTMLButtonElement>('[data-action="cancel"]')!.click();
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('aborts an in-flight nostrconnect on detach', async () => {
      const signer = makeSignerStub();
      let signalRef: AbortSignal | undefined;
      signer.loginWithNostrConnect.mockImplementation(
        (opts) =>
          new Promise<StoredAccount>((_, reject) => {
            signalRef = opts.signal;
            opts.signal!.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const binding = attachLoginListeners(root, asSigner(signer));
      const form = root.querySelector<HTMLFormElement>('[data-form="nostrconnect"]')!;
      (form.elements.namedItem('relays') as HTMLInputElement).value = 'wss://a.test';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await flush();
      binding.detach();
      expect(signalRef?.aborted).toBe(true);
    });
  });
});
