import { useEffect, useState } from "react";
import type { Layer, Trace, TraceEntry } from "./trace";

const LAYERS: Array<{ id: Layer | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "sdk", label: "SDK calls" },
  { id: "relay", label: "Relays" },
  { id: "blossom", label: "Blossom" },
];

/** Live view of every SDK call and every request it made. Newest first. */
export function Inspector({ trace }: { trace: Trace }) {
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [layer, setLayer] = useState<Layer | "all">("all");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => trace.subscribe(setEntries), [trace]);
  const shown = entries.filter((e) => layer === "all" || e.layer === layer);

  return (
    <aside className="inspector">
      <div className="row">
        <h2>Inspector</h2>
        <button onClick={() => trace.clear()}>Clear</button>
      </div>
      <div className="row">
        {LAYERS.map((l) => (
          <button key={l.id} className={layer === l.id ? "on" : ""} onClick={() => setLayer(l.id)}>{l.label}</button>
        ))}
      </div>
      <p className="muted">SDK calls show the function and its arguments (secrets redacted). Relay and Blossom lines are the traffic those calls caused. Event contents are ciphertext.</p>
      <ol>
        {shown.map((e) => (
          <li key={e.seq} className={`entry ${e.layer} ${e.error ? "err" : ""}`}>
            <button className="head" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
              <span className="tag">{e.layer}</span>
              <strong>{e.name}</strong>
              <span className="muted">{e.pending ? "…" : e.error ? "failed" : `${e.ms} ms`}</span>
            </button>
            {open === e.seq && (
              <div className="detail">
                <h4>arguments</h4>
                <pre>{e.args}</pre>
                {e.result && (<><h4>result</h4><pre>{e.result}</pre></>)}
                {e.error && (<><h4>error</h4><pre>{e.error}</pre></>)}
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
