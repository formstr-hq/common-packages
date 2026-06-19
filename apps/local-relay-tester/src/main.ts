/**
 * local-relay tester — drives the FULL contract against a real user:
 *   1. express interest in the user's CONTACT LIST (kind 3) → derive follows
 *   2. express interest in their FOLLOWING FEED (kind 1 from those follows)
 *   3. express interest in PROFILES (kind 0) of the authors → avatars + names
 *   4. express interest in LIKES (kind 7) and ZAPS (kind 9735) of visible notes
 *
 * Everything is a declared interest; the worker (local relay) owns the network
 * and fulfills them. Reads stay cache-only — the worker keeps the store warm.
 */
import {
  DataLayer,
  LocalRelayClient,
  workerChannel,
  buildFilters,
  assembleFeed,
  type Event,
  type Filter,
  type ObserveHandle,
  type RelayHealth,
} from "@formstr/local-relay";
import { nip19, generateSecretKey, finalizeEvent } from "nostr-tools";

const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];
// fiatjaf — follows lots of active accounts, so the following feed fills fast.
const DEFAULT_PUBKEY =
  "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";

// ---- spawn the worker + wire the contract ----
const worker = new Worker(new URL("./relay.worker.ts", import.meta.url), { type: "module" });
const client = new LocalRelayClient(workerChannel(worker));
const sk = generateSecretKey(); // ephemeral; this tester only reads
const dataLayer = new DataLayer({ client, sign: async (t) => finalizeEvent(t, sk) as Event });

// ---- state ----
const notes = new Map<string, Event>(); // kind 1 from follows
const profiles = new Map<string, { name: string; picture?: string }>(); // kind 0
const likes = new Map<string, Set<string>>(); // noteId -> reactor pubkeys
const zaps = new Map<string, { count: number; sats: number }>(); // noteId -> totals
let follows: string[] = [];

const handles: Record<string, ObserveHandle | null> = {
  contacts: null,
  feed: null,
  profiles: null,
  likes: null,
  zaps: null,
};

// ---- DOM ----
const $ = (id: string) => document.getElementById(id)!;
const pubkeyInput = $("pubkey") as HTMLInputElement;
const relaysInput = $("relays") as HTMLInputElement;
const status = $("status");
const feed = $("feed");
const healthEl = $("health");
const statsEl = $("stats");
pubkeyInput.value = DEFAULT_PUBKEY;
relaysInput.value = DEFAULT_RELAYS.join(", ");

function setStatus(text: string, kind: "idle" | "live" | "done" = "idle") {
  status.textContent = text;
  status.className = kind;
}

function toHex(input: string): string {
  const v = input.trim();
  if (v.startsWith("npub") || v.startsWith("nprofile")) {
    const d = nip19.decode(v);
    if (d.type === "npub") return d.data as string;
    if (d.type === "nprofile") return (d.data as { pubkey: string }).pubkey;
  }
  return v;
}

function profileContent(e: Event): { name: string; picture?: string } {
  try {
    const m = JSON.parse(e.content);
    return { name: m.display_name || m.name || e.pubkey.slice(0, 8), picture: m.picture };
  } catch {
    return { name: e.pubkey.slice(0, 8) };
  }
}

// Best-effort zap amount: the receipt embeds the zap request (kind 9734) in its
// "description" tag, which carries an "amount" tag in millisats.
function zapSats(receipt: Event): number {
  const desc = receipt.tags.find((t) => t[0] === "description")?.[1];
  if (!desc) return 0;
  try {
    const req = JSON.parse(desc) as { tags?: string[][] };
    const amt = req.tags?.find((t) => t[0] === "amount")?.[1];
    return amt ? Math.round(parseInt(amt, 10) / 1000) : 0;
  } catch {
    return 0;
  }
}

function eTagsOf(e: Event): string[] {
  return e.tags.filter((t) => t[0] === "e" && t[1]).map((t) => t[1]);
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    render();
  });
}

function render() {
  const list = assembleFeed(Array.from(notes.values()), { feedRootsOnly: true }).slice(0, 100);

  statsEl.innerHTML = [
    `${follows.length} follows`,
    `${notes.size} notes`,
    `${profiles.size} profiles`,
    `${likes.size} liked`,
    `${zaps.size} zapped`,
  ]
    .map((s) => `<span class="stat">${s}</span>`)
    .join("");

  feed.innerHTML = list
    .map((e) => {
      const p = profiles.get(e.pubkey);
      const avatar = p?.picture
        ? `<img class="avatar" src="${p.picture}" onerror="this.style.visibility='hidden'" />`
        : `<div class="avatar ph">${(p?.name ?? e.pubkey).slice(0, 1).toUpperCase()}</div>`;
      const name = p?.name ?? e.pubkey.slice(0, 8) + "…";
      const when = new Date(e.created_at * 1000).toLocaleString();
      const body = (e.content || "").replace(/</g, "&lt;").slice(0, 400);
      const likeCount = likes.get(e.id)?.size ?? 0;
      const z = zaps.get(e.id);
      return `<div class="note">
        <div class="head">${avatar}<div><div class="name">${name}</div><div class="meta">${when}</div></div></div>
        <div class="body">${body || "<em>(no text)</em>"}</div>
        <div class="engage">❤ ${likeCount}&nbsp;&nbsp;⚡ ${z?.count ?? 0}${z?.sats ? ` (${z.sats} sats)` : ""}</div>
      </div>`;
    })
    .join("");

  // Keep the engagement interests pointed at the currently visible notes.
  updateEngagementInterests(list.map((e) => e.id));
}

// ---- the interests ----

function start() {
  stop();
  const pubkey = toHex(pubkeyInput.value);
  const relays = relaysInput.value.split(",").map((r) => r.trim()).filter(Boolean);
  client.setUserRelays(relays);

  setStatus(`interest: contact list of ${pubkey.slice(0, 8)}… — awaiting`, "live");

  // 1) Contact list (kind 3) → follows. Replaceable; newest wins.
  handles.contacts = dataLayer.observe([{ kinds: [3], authors: [pubkey], limit: 1 }], {
    onEvent: (e) => {
      const next = e.tags.filter((t) => t[0] === "p" && t[1]).map((t) => t[1]);
      if (next.length && next.join(",") !== follows.join(",")) {
        follows = next;
        openFollowingInterests();
      }
    },
  });
}

function openFollowingInterests() {
  setStatus(`following feed: ${follows.length} authors — worker syncing upstream`, "live");

  // 2) Following feed (kind 1 from the follows) — outbox-routed by the worker.
  handles.feed?.unobserve();
  handles.feed = dataLayer.observe(
    buildFilters([1], { type: "following" }, { pubkey: toHex(pubkeyInput.value), follows }, { limit: 200 }),
    {
      onEvent: (e) => {
        notes.set(e.id, e);
        scheduleRender();
      },
      onEose: () => setStatus(`following feed live — ${notes.size} notes, worker syncing`, "live"),
    }
  );

  // 3) Profiles (kind 0) — a CACHE-ONLY read. We deliberately express NO network
  //    interest in profiles; the worker ENRICHES the store with author kind:0 as
  //    it syncs the feed, and we just read them from cache (localOnly = no socket).
  //    Avatars appearing proves enrichment + cache reads work end-to-end.
  handles.profiles?.unobserve();
  handles.profiles = dataLayer.observe(
    [{ kinds: [0], authors: follows }],
    {
      onEvent: (e) => {
        const prev = profiles.get(e.pubkey);
        profiles.set(e.pubkey, profileContent(e));
        if (!prev) scheduleRender();
      },
    },
    { localOnly: true }
  );
}

// 4) Likes (kind 7) + zaps (kind 9735) of the currently visible notes. Re-declared
//    (widened) as the visible set changes — still declarative; the worker decides.
let engagementKey = "";
function updateEngagementInterests(noteIds: string[]) {
  if (noteIds.length === 0) return;
  const key = noteIds.join(",");
  if (key === engagementKey) return;
  engagementKey = key;

  const likesFilter: Filter[] = [{ kinds: [7], "#e": noteIds } as Filter];
  const zapsFilter: Filter[] = [{ kinds: [9735], "#e": noteIds } as Filter];

  if (handles.likes) handles.likes.update(likesFilter);
  else
    handles.likes = dataLayer.observe(likesFilter, {
      onEvent: (e) => {
        for (const id of eTagsOf(e)) {
          if (!likes.has(id)) likes.set(id, new Set());
          likes.get(id)!.add(e.pubkey);
        }
        scheduleRender();
      },
    });

  if (handles.zaps) handles.zaps.update(zapsFilter);
  else
    handles.zaps = dataLayer.observe(zapsFilter, {
      onEvent: (e) => {
        const sats = zapSats(e);
        for (const id of eTagsOf(e)) {
          const cur = zaps.get(id) ?? { count: 0, sats: 0 };
          zaps.set(id, { count: cur.count + 1, sats: cur.sats + sats });
        }
        scheduleRender();
      },
    });
}

function stop() {
  Object.keys(handles).forEach((k) => {
    handles[k]?.unobserve();
    handles[k] = null;
  });
  notes.clear();
  profiles.clear();
  likes.clear();
  zaps.clear();
  follows = [];
  engagementKey = "";
  render();
}

$("go").addEventListener("click", start);
$("stop").addEventListener("click", () => {
  stop();
  setStatus("all interests dropped", "done");
});

function renderHealth(health: RelayHealth[]) {
  healthEl.innerHTML = health
    .map((h) => {
      const state = h.connected
        ? "connected"
        : h.connecting
        ? "connecting"
        : h.reconnecting
        ? "reconnecting"
        : "down";
      return `<span class="relay ${state}">${h.relay.replace("wss://", "")} · ${state}</span>`;
    })
    .join("");
}

setInterval(async () => {
  try {
    renderHealth(await dataLayer.relayHealth());
  } catch {
    /* worker warming up */
  }
}, 1500);

setStatus("ready — enter a pubkey and click “Load following feed”", "idle");
