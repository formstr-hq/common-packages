import { SimplePoolRuntime, type NostrRuntime, type SubscriptionHandle } from "@formstr/kanban-sdk";
import type { Event, Filter } from "nostr-tools";

/**
 * The point of the demo: every byte the SDK puts on or takes off the wire is
 * visible. Because `NostrRuntime` is the SDK's only I/O seam, decorating it is
 * enough — no SDK change, no hooks inside the codec.
 */
export type LogDirection = "publish" | "query" | "receive";

export interface LogEntry {
  seq: number;
  at: number;
  direction: LogDirection;
  /** Event kind, or the kinds asked for on a query. */
  label: string;
  /** Raw event or filter, pretty-printed. What a relay operator would see. */
  detail: string;
  /** Present on events: the `content` field, which is ciphertext on private kinds. */
  content?: string;
  /** How long a publish/query took, in ms. */
  ms?: number;
  error?: string;
}

const MAX_ENTRIES = 400;

export class LoggingRuntime implements NostrRuntime {
  private readonly inner: NostrRuntime;
  private readonly listeners = new Set<(entries: LogEntry[]) => void>();
  private entries: LogEntry[] = [];
  private seq = 0;

  constructor(inner: NostrRuntime = new SimplePoolRuntime()) {
    this.inner = inner;
  }

  subscribeToLog(cb: (entries: LogEntry[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.entries);
    return () => this.listeners.delete(cb);
  }

  clearLog(): void {
    this.entries = [];
    this.emit();
  }

  private push(entry: Omit<LogEntry, "seq" | "at">): void {
    this.seq += 1;
    // Newest first — a live demo reads from the top.
    this.entries = [{ ...entry, seq: this.seq, at: Date.now() }, ...this.entries].slice(
      0,
      MAX_ENTRIES,
    );
    this.emit();
  }

  private emit(): void {
    for (const cb of this.listeners) cb(this.entries);
  }

  async querySync(relays: string[], filter: Filter, timeoutMs?: number): Promise<Event[]> {
    const started = Date.now();
    try {
      const events = await this.inner.querySync(relays, filter, timeoutMs);
      this.push({
        direction: "query",
        label: `query kinds ${filter.kinds?.join(",") ?? "*"} → ${events.length}`,
        detail: JSON.stringify(filter, null, 2),
        ms: Date.now() - started,
      });
      for (const event of events) {
        this.push({
          direction: "receive",
          label: `kind ${event.kind}`,
          detail: JSON.stringify(event, null, 2),
          content: event.content,
        });
      }
      return events;
    } catch (error) {
      this.push({
        direction: "query",
        label: `query kinds ${filter.kinds?.join(",") ?? "*"} failed`,
        detail: JSON.stringify(filter, null, 2),
        ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  subscribe(
    relays: string[],
    filters: Filter[],
    options: { onEvent?: (event: Event) => void; onEose?: () => void } = {},
  ): SubscriptionHandle {
    return this.inner.subscribe(relays, filters, {
      ...options,
      onEvent: (event) => {
        this.push({
          direction: "receive",
          label: `kind ${event.kind}`,
          detail: JSON.stringify(event, null, 2),
          content: event.content,
        });
        options.onEvent?.(event);
      },
    });
  }

  async publish(relays: string[], event: Event, timeoutMs?: number): Promise<void> {
    const started = Date.now();
    this.push({
      direction: "publish",
      label: `kind ${event.kind}`,
      detail: JSON.stringify(event, null, 2),
      content: event.content,
    });
    await this.inner.publish(relays, event, timeoutMs);
    // `publish` resolves on timeout as well as on success — see SimplePoolRuntime.
    // So this records that we finished trying, never that a relay stored it.
    this.push({
      direction: "publish",
      label: `kind ${event.kind} — send finished`,
      detail: `${event.id}\nsent to:\n${relays.join("\n")}`,
      ms: Date.now() - started,
    });
  }

  dispose(): void {
    this.inner.dispose?.();
  }
}
