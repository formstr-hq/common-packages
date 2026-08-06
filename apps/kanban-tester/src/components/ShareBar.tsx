import { boardCoordinate, type KanbanBoard } from "@formstr/kanban-sdk";
import { nip19 } from "nostr-tools";

import { useApp } from "../nostr/AppContext";
import { useToast } from "../ui/Toast";

function CopyButton({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <button
      className="link"
      type="button"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => toast.notify(`${label} copied`, "success"))
          .catch(toast.fail);
      }}
    >
      Copy {label}
    </button>
  );
}

export function ShareBar({ board }: { board: KanbanBoard }) {
  const { relays } = useApp();
  const coordinate = boardCoordinate(board);
  const naddr = nip19.naddrEncode({
    identifier: board.id,
    pubkey: board.pubkey,
    kind: board.isPrivate ? 32301 : 30301,
    relays: relays.slice(0, 2),
  });

  return (
    <div className="sharebar">
      <code className="coordinate">{coordinate}</code>
      <CopyButton label="coordinate" value={coordinate} />
      <CopyButton label="naddr" value={naddr} />
      {board.viewKey && <CopyButton label="view key" value={board.viewKey} />}

      {board.isPrivate ? (
        <span className="muted small">
          Anyone holding this view key can read the board. Share it by inviting an npub, not by
          pasting the key — invitations are gift-wrapped, and rotation can revoke them.
        </span>
      ) : (
        <span className="muted small">
          Public board, byte-compatible with NIP-100. To check interop: open{" "}
          <a href="https://kanbanstr.com" target="_blank" rel="noreferrer">
            kanbanstr.com
          </a>
          , point it at one of these relays, and this board appears in its All Boards list.
        </span>
      )}
    </div>
  );
}
