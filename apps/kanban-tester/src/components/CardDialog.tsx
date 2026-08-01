import type { CardDraft, KanbanBoard, KanbanCard } from "@formstr/kanban-sdk";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { Modal } from "../ui/Modal";
import { useToast } from "../ui/Toast";
import { CommentThread } from "./CommentThread";

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Assignees are hex pubkeys on the wire; the UI accepts npub and converts. */
function toHexPubkeys(values: string[]): string[] {
  return values.map((value) => {
    if (!value.startsWith("npub1")) return value;
    const decoded = nip19.decode(value);
    if (decoded.type !== "npub") throw new Error(`Not an npub: ${value}`);
    return decoded.data;
  });
}

export function CardDialog({
  board,
  card,
  status,
  canWrite,
  onClose,
  onSave,
  onDelete,
}: {
  board: KanbanBoard;
  card: KanbanCard | null;
  status: string;
  canWrite: boolean;
  onClose(): void;
  onSave(draft: CardDraft): Promise<void>;
  onDelete?(): Promise<void>;
  onChanged(): void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState(card?.title ?? "");
  const [description, setDescription] = useState(card?.description ?? "");
  const [labels, setLabels] = useState((card?.labels ?? []).join(", "));
  const [assignees, setAssignees] = useState(
    (card?.assignees ?? []).map((pubkey) => nip19.npubEncode(pubkey)).join(", "),
  );
  const [busy, setBusy] = useState(false);

  return (
    <Modal title={card ? "Card" : "New card"} onClose={onClose} wide>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          try {
            void onSave({
              title,
              description,
              status,
              labels: splitList(labels),
              assignees: toHexPubkeys(splitList(assignees)),
            }).finally(() => setBusy(false));
          } catch (error) {
            setBusy(false);
            toast.fail(error);
          }
        }}
      >
        <label>
          Title
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            autoFocus
            disabled={!canWrite}
          />
        </label>
        <label>
          Description
          <textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={!canWrite}
          />
        </label>
        <label>
          Labels (comma separated)
          <input value={labels} onChange={(e) => setLabels(e.target.value)} disabled={!canWrite} />
        </label>
        <label>
          Assignees (npub, comma separated)
          <input
            value={assignees}
            onChange={(e) => setAssignees(e.target.value)}
            disabled={!canWrite}
          />
        </label>

        {canWrite && (
          <div className="row-actions">
            <button disabled={busy} type="submit">
              {busy ? "Publishing…" : card ? "Save card" : "Create card"}
            </button>
            {card && onDelete && (
              <button
                className="danger"
                type="button"
                onClick={() => {
                  setBusy(true);
                  void onDelete().finally(() => setBusy(false));
                }}
              >
                Delete
              </button>
            )}
          </div>
        )}
      </form>

      {card && (
        <>
          <hr />
          <CommentThread board={board} cardId={card.id} />
        </>
      )}
    </Modal>
  );
}
