import type { BoardDraft, Column } from "@formstr/kanban-sdk";
import { useState } from "react";

import { Modal } from "../ui/Modal";

const DEFAULT_COLUMNS = ["Todo", "Doing", "Done"];

function toColumns(names: string[]): Column[] {
  return names
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({ id: crypto.randomUUID(), name, order: index }));
}

export function NewBoardDialog({
  onClose,
  onCreate,
}: {
  onClose(): void;
  onCreate(draft: BoardDraft): Promise<void>;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [columnText, setColumnText] = useState(DEFAULT_COLUMNS.join("\n"));
  const [isPrivate, setIsPrivate] = useState(true);
  const [busy, setBusy] = useState(false);

  return (
    <Modal title="New board" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          void onCreate({
            title,
            description,
            columns: toColumns(columnText.split("\n")),
            private: isPrivate,
          }).finally(() => setBusy(false));
        }}
      >
        <label>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <label>
          Columns (one per line)
          <textarea
            rows={4}
            value={columnText}
            onChange={(e) => setColumnText(e.target.value)}
            required
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={isPrivate}
            onChange={(e) => setIsPrivate(e.target.checked)}
          />
          Private board (kind 32301, nip44-encrypted under a fresh view key)
        </label>
        <p className="muted small">
          {isPrivate
            ? "Title, description, columns and every card are encrypted. Relays see an opaque blob and a random `d` tag. The view key is written into your board list so you can recover it."
            : "Public board (kind 30301) — byte-compatible with kanbanstr.com. Everything is world-readable, permanently."}
        </p>
        <button disabled={busy} type="submit">
          {busy ? "Publishing…" : "Create board"}
        </button>
      </form>
    </Modal>
  );
}
