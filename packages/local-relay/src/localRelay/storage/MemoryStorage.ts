/**
 * In-memory StorageAdapter for tests and Node/SSR. Synchronous under the hood,
 * wrapped in resolved promises to honour the async contract.
 */
import type { Event, OutboxRecord } from "../core/types";
import { StorageAdapter } from "./StorageAdapter";

export class MemoryStorage implements StorageAdapter {
  private map = new Map<string, Event>();
  private outbox = new Map<string, OutboxRecord>();

  async loadAll(): Promise<Event[]> {
    return Array.from(this.map.values());
  }

  async batchPut(events: Event[]): Promise<void> {
    for (const e of events) this.map.set(e.id, e);
  }

  async batchDelete(ids: string[]): Promise<void> {
    for (const id of ids) this.map.delete(id);
  }

  async clear(): Promise<void> {
    this.map.clear();
    this.outbox.clear();
  }

  async loadOutbox(): Promise<OutboxRecord[]> {
    return Array.from(this.outbox.values());
  }

  async putOutbox(records: OutboxRecord[]): Promise<void> {
    for (const r of records) this.outbox.set(r.eventId, r);
  }

  async deleteOutbox(eventIds: string[]): Promise<void> {
    for (const id of eventIds) this.outbox.delete(id);
  }

  /** Test-only synchronous size accessor. */
  get size(): number {
    return this.map.size;
  }
}
