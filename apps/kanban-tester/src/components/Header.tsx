import { useState } from "react";

import { useApp } from "../nostr/AppContext";
import { parseRelayInput } from "../nostr/relays";
import { navigate } from "../router";

export function Header({ onToggleLog }: { onToggleLog(): void }) {
  const { account, active, relays, setRelays, signer, syncSigner } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(relays.join("\n"));

  return (
    <header className="app-header">
      <button className="brand" onClick={() => navigate("#/")} type="button">
        kanban-tester
      </button>

      <div className="header-relays">
        {editing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const next = parseRelayInput(draft);
              if (next.length > 0) setRelays(next);
              setEditing(false);
            }}
          >
            <textarea rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <button type="submit">Use these relays</button>
          </form>
        ) : (
          <button
            className="link"
            onClick={() => {
              setDraft(relays.join("\n"));
              setEditing(true);
            }}
            type="button"
            title={relays.join("\n")}
          >
            {relays.length} relays
          </button>
        )}
      </div>

      <button className="link" onClick={onToggleLog} type="button">
        Event log
      </button>

      {account && (
        <div className="header-account">
          <span className={active ? "npub" : "npub locked"}>
            {account.npub.slice(0, 12)}…{account.npub.slice(-4)}
            {!active && " (locked)"}
          </span>
          {/* The full npub is what someone else needs to invite you, and it is
              never shown in full anywhere else. */}
          <button
            className="link"
            type="button"
            title={account.npub}
            onClick={() => void navigator.clipboard.writeText(account.npub)}
          >
            Copy npub
          </button>
          <button
            className="link"
            type="button"
            onClick={() => {
              void signer.logout().then(syncSigner);
              navigate("#/");
            }}
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
