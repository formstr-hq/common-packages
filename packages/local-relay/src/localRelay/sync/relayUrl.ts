/**
 * One spelling per relay. Relay lists in the wild mix `wss://relay.damus.io` and
 * `wss://relay.damus.io/` (and upper-case hosts); treated as different strings
 * they became separate sockets to the same relay — doubling our load on exactly
 * the relays that rate-limit per IP, and splitting their limits' accounting.
 *
 * Lower-cases scheme and host, drops a bare trailing "/" (a real path such as
 * `/v1` is kept — that can be a different relay), the default port, and any
 * fragment. Unparseable input is returned trimmed, unchanged otherwise.
 */
export function normalizeRelayUrl(url: string): string {
  const raw = url.trim();
  try {
    const u = new URL(raw);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return raw;
    const port =
      u.port && !((u.protocol === "wss:" && u.port === "443") || (u.protocol === "ws:" && u.port === "80"))
        ? `:${u.port}`
        : "";
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.hostname.toLowerCase()}${port}${path}${u.search}`;
  } catch {
    return raw;
  }
}

/** Normalize and de-duplicate a list of relay URLs, keeping first-seen order. */
export function normalizeRelays(urls: readonly string[]): string[] {
  return Array.from(new Set(urls.map(normalizeRelayUrl)));
}
