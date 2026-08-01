import type { KanbanBoard } from "@formstr/kanban-sdk";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { useMembers } from "../hooks/useMembers";
import { useApp } from "../nostr/AppContext";
import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";

function toHex(value: string): string {
  if (!value.startsWith("npub1")) return value;
  const decoded = nip19.decode(value);
  if (decoded.type !== "npub") throw new Error(`Not an npub: ${value}`);
  return decoded.data;
}

export function MembersPanel({
  board,
  onClose,
  onChanged,
}: {
  board: KanbanBoard;
  onClose(): void;
  onChanged(): void;
}) {
  const { sdk, account } = useApp();
  const toast = useToast();
  const members = useMembers(board);
  const [invitee, setInvitee] = useState("");
  const [role, setRole] = useState<"maintainer" | "member">("member");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingRemoval, setPendingRemoval] = useState<string[]>([]);

  const isOwner = account?.pubkey === board.pubkey;

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await sdk!.invite(board, [{ pubkey: toHex(invitee), role }], message);
      toast.notify("Invitation gift-wrapped and sent to their inbox relays", "success");
      setInvitee("");
      setMessage("");
      onChanged();
      await members.refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove(pubkey: string, rotate: boolean) {
    setBusy(true);
    try {
      await sdk!.removeMember(board, pubkey, { rotate });
      if (rotate) {
        toast.notify("Removed and board re-keyed — their old key opens nothing new", "success");
      } else {
        setPendingRemoval((current) => [...new Set([...current, pubkey])]);
        toast.notify("Staged only — they keep full access until you rotate");
      }
      onChanged();
      await members.refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    setBusy(true);
    try {
      const result = await sdk!.rotateBoardKey(board, { remove: pendingRemoval });
      toast.notify(
        `Rotated: ${result.cardsRewritten} cards and ${result.commentsRewritten} comments re-encrypted, ${result.invited.length} members re-invited`,
        "success",
      );
      setPendingRemoval([]);
      onChanged();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Members" onClose={onClose} wide>
      <ul className="list">
        {members.data.map((member) => (
          <li key={member.pubkey} className="list-row">
            <div>
              <code>{nip19.npubEncode(member.pubkey).slice(0, 20)}…</code>
              <div className="muted small">{member.role}</div>
            </div>
            {isOwner && member.role !== "owner" && (
              <div className="row-actions">
                <button disabled={busy} onClick={() => void remove(member.pubkey, true)}>
                  Remove &amp; re-key
                </button>
                <button
                  className="link"
                  disabled={busy}
                  title="Drops their tag without re-keying. They keep reading until you rotate — use when removing several people at once."
                  onClick={() => void remove(member.pubkey, false)}
                >
                  Stage only
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>

      {isOwner && (
        <>
          <hr />
          <form className="stack" onSubmit={invite}>
            <h3>Invite</h3>
            <label>
              npub
              <input
                value={invitee}
                onChange={(e) => setInvitee(e.target.value)}
                placeholder="npub1…"
                required
              />
            </label>
            <label>
              Role
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="member">member — read and comment</option>
                <option value="maintainer">maintainer — read, comment, write cards</option>
              </select>
            </label>
            <label>
              Message
              <input value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <p className="muted small">
              The view key is sealed to their pubkey and gift-wrapped (kind 1053), then sent to
              their NIP-65 inbox relays. Note: 1053 gets none of the relay-side protection NIP-59
              defines for 1059, so anyone can see <em>that</em> they were invited.
            </p>
            <button disabled={busy} type="submit">
              Send invitation
            </button>
          </form>

          <hr />
          <div className="stack">
            <h3>Rotate view key</h3>
            <p className="muted small">
              Mints a new view key, re-encrypts every card and comment under it, and re-invites the
              remaining members. Removed members keep everything they already read — rotation cuts
              off future writes, it does not retroactively hide the past. Not atomic: it is O(cards)
              publishes, and a failure part-way leaves a mix.
            </p>
            {pendingRemoval.length > 0 && (
              <p className="notice">
                {pendingRemoval.length} removed member(s) will be excluded from the new key.
              </p>
            )}
            <button className="danger" disabled={busy} onClick={() => void rotate()} type="button">
              {busy ? "Rotating…" : "Rotate key"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
