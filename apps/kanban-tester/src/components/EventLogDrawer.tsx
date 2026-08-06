import { KANBAN_KINDS } from "@formstr/kanban-sdk";
import { useEffect, useState } from "react";

import { useApp } from "../nostr/AppContext";
import type { LogEntry } from "../nostr/loggingRuntime";

/** Kinds whose `content` is nip44 ciphertext, so the drawer can label it as such. */
const ENCRYPTED_KINDS = new Set<number>([
  KANBAN_KINDS.privateBoard,
  KANBAN_KINDS.privateCard,
  KANBAN_KINDS.boardList,
  KANBAN_KINDS.privateComment,
  KANBAN_KINDS.inviteGiftWrap,
  KANBAN_KINDS.seal,
]);

function Row({ entry }: { entry: LogEntry }) {
  const [open, setOpen] = useState(false);
  const kind = Number(/kind (\d+)/.exec(entry.label)?.[1]);
  const encrypted = ENCRYPTED_KINDS.has(kind);

  return (
    <li className={`log-row log-${entry.direction}`}>
      <button className="log-summary" onClick={() => setOpen((o) => !o)} type="button">
        <span className="log-dir">{entry.direction}</span>
        <span>{entry.label}</span>
        {encrypted && <span className="chip chip-lock">encrypted</span>}
        {entry.ms !== undefined && <span className="muted small">{entry.ms}ms</span>}
        {entry.error && <span className="chip chip-error">error</span>}
      </button>
      {entry.content !== undefined && (
        <div className="log-content">
          {encrypted ? (
            <>
              <span className="muted small">content as a relay sees it:</span>
              <code className="block ciphertext">{entry.content.slice(0, 180) || "(empty)"}…</code>
            </>
          ) : (
            <code className="block">{entry.content.slice(0, 180) || "(empty)"}</code>
          )}
        </div>
      )}
      {open && <pre className="log-detail">{entry.detail}</pre>}
      {entry.error && <p className="error small">{entry.error}</p>}
    </li>
  );
}

/**
 * Every event the SDK sent or received, live. The point: on a private board the
 * card kinds show up as nip44 ciphertext, and the outer tags carry nothing but a
 * random `d` and a blinded `b` pointer.
 */
export function EventLogDrawer({ onClose }: { onClose(): void }) {
  const { runtime } = useApp();
  const [entries, setEntries] = useState<LogEntry[]>([]);

  useEffect(() => runtime.subscribeToLog(setEntries), [runtime]);

  return (
    <aside className="log-drawer">
      <div className="panel-head">
        <h2>Event log</h2>
        <div className="row-actions">
          <button className="link" onClick={() => runtime.clearLog()} type="button">
            Clear
          </button>
          <button className="link" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
      <p className="muted small">
        Everything the SDK put on or took off the wire, newest first. Click a row for the raw event.
      </p>
      <ul className="log-list">
        {entries.map((entry) => (
          <Row key={entry.seq} entry={entry} />
        ))}
      </ul>
    </aside>
  );
}
