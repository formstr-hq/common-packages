import { nip19 } from "nostr-tools";
import { useState } from "react";

import { useInvitations } from "../hooks/useInvitations";
import { useApp } from "../nostr/AppContext";
import { boardHref, navigate } from "../router";
import { useToast } from "../ui/Toast";

export function InvitationsInbox({ onAccepted }: { onAccepted(): void }) {
  const { sdk } = useApp();
  const toast = useToast();
  const invitations = useInvitations();
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Invitations</h2>
        <button className="link" onClick={() => void invitations.refresh()} type="button">
          {invitations.loading ? "Checking…" : "Check inbox"}
        </button>
      </div>

      {invitations.data.length === 0 && !invitations.loading && (
        <p className="muted small">
          No gift-wrapped board keys addressed to you on these relays.
        </p>
      )}

      <ul className="list">
        {invitations.data.map((invitation) => (
          <li key={invitation.wrapId} className="list-row">
            <div>
              <strong>{invitation.role}</strong> on <code>{invitation.coordinate.slice(0, 30)}…</code>
              <div className="muted small">
                from {nip19.npubEncode(invitation.inviterPubkey).slice(0, 16)}…
                {invitation.message && ` — “${invitation.message}”`}
              </div>
            </div>
            <div className="row-actions">
              <button
                disabled={busy === invitation.wrapId}
                type="button"
                onClick={() => {
                  setBusy(invitation.wrapId);
                  void sdk!
                    .acceptInvitation(invitation)
                    .then(() => {
                      toast.notify("Accepted — view key stored in your board list", "success");
                      onAccepted();
                      void invitations.refresh();
                      navigate(boardHref(invitation.coordinate));
                    })
                    .catch(toast.fail)
                    .finally(() => setBusy(null));
                }}
              >
                Accept
              </button>
              <button
                className="link"
                type="button"
                onClick={() => {
                  void sdk!
                    .dismissInvitation(invitation)
                    .then(() => invitations.refresh())
                    .catch(toast.fail);
                }}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
