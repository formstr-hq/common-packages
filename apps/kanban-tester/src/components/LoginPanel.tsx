import { useState } from "react";

import { useApp } from "../nostr/AppContext";
import { useToast } from "../ui/Toast";

type Tab = "create" | "ncryptsec" | "extension" | "bunker";

const TABS: { id: Tab; label: string }[] = [
  { id: "create", label: "New key" },
  { id: "ncryptsec", label: "Existing key" },
  { id: "extension", label: "Extension" },
  { id: "bunker", label: "Bunker" },
];

/**
 * Deliberately not @formstr/signer's bundled login UI: that one renders raw HTML
 * strings, which fights React. It drives the same `Signer` methods.
 */
export function LoginPanel() {
  const { signer, account, syncSigner } = useApp();
  const toast = useToast();
  // A locked-but-known ncryptsec account only needs its passphrase back.
  const [tab, setTab] = useState<Tab>(account?.ncryptsec ? "ncryptsec" : "create");
  const [busy, setBusy] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [ncryptsec, setNcryptsec] = useState(account?.ncryptsec ?? "");
  const [bunkerUri, setBunkerUri] = useState("");
  const [createdNcryptsec, setCreatedNcryptsec] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
      syncSigner();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel login">
      <h1>kanban-tester</h1>
      <p className="muted">
        A demo host for <code>@formstr/kanban-sdk</code>. Boards and cards are real Nostr events on
        real public relays.
      </p>

      {account && (
        <p className="notice">
          <strong>{account.npub.slice(0, 16)}…</strong> is signed in but locked — every account
          rehydrates locked after a reload. Unlock it to continue.
        </p>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={t.id === tab ? "tab tab-active" : "tab"}
            onClick={() => setTab(t.id)}
            type="button"
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "create" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const created = await signer.createAccount(passphrase);
              setCreatedNcryptsec(created.ncryptsec);
            });
          }}
        >
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              placeholder="encrypts the key at rest (NIP-49)"
              required
            />
          </label>
          <button disabled={busy} type="submit">
            Create throwaway identity
          </button>
          {createdNcryptsec && (
            <p className="notice">
              Save this if you want the identity back on another machine:
              <code className="block">{createdNcryptsec}</code>
            </p>
          )}
        </form>
      )}

      {tab === "ncryptsec" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => signer.loginWithNcryptsec(ncryptsec, passphrase));
          }}
        >
          <label>
            ncryptsec
            <input
              value={ncryptsec}
              onChange={(e) => setNcryptsec(e.target.value)}
              placeholder="ncryptsec1…"
              required
            />
          </label>
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              required
            />
          </label>
          <button disabled={busy} type="submit">
            Unlock
          </button>
        </form>
      )}

      {tab === "extension" && (
        <div className="stack">
          <p className="muted">
            Uses <code>window.nostr</code>. The extension must expose <code>nip44</code> — private
            boards cannot be read without it.
          </p>
          <button disabled={busy} onClick={() => void run(() => signer.loginWithExtension())}>
            Connect extension
          </button>
        </div>
      )}

      {tab === "bunker" && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => signer.loginWithBunkerUri(bunkerUri));
          }}
        >
          <label>
            Bunker URI
            <input
              value={bunkerUri}
              onChange={(e) => setBunkerUri(e.target.value)}
              placeholder="bunker://…"
              required
            />
          </label>
          <button disabled={busy} type="submit">
            Pair
          </button>
        </form>
      )}
    </div>
  );
}
