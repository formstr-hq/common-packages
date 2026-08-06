import { DEFAULT_RELAYS } from "@formstr/kanban-sdk";

const STORAGE_KEY = "kanban-tester:relays";

export function loadRelays(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [...DEFAULT_RELAYS];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed as string[];
  } catch {
    // fall through to defaults
  }
  return [...DEFAULT_RELAYS];
}

export function saveRelays(relays: string[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(relays));
}

export function parseRelayInput(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((url) => url.trim())
    .filter(Boolean);
}
