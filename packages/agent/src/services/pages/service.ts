import {
  signerManager,
  nostrRuntime,
  relayManager,
  nip44SelfEncrypt,
  nip44SelfDecrypt,
  encodeNKeys,
} from "@formstr/core";
import type { EventTemplate, Event, Filter } from "nostr-tools";
import { finalizeEvent, nip19 } from "nostr-tools";

import {
  PAGES_KINDS,
  type DocMetadata,
  type PageDocument,
  type PageSummary,
  type ShareResult,
  type SharedPageEntry,
} from "./types";
import { generateViewKey, encryptWithViewKey, decryptWithViewKey, hexToBytes } from "./viewKey";
import {
  authorSet,
  collabRoom,
  contentTags,
  decodeRosterEvent,
  isOpenRoster,
  parseRosterPayload,
  parseRootAddress,
  rosterDTag,
  rootAddress,
  selectTip,
  type DocMember,
  type DocMode,
  type DocRoster,
} from "./sharedDoc";

const RELAYS = () => relayManager.getRelaysForModule("pages");

// ── Save / Update ───────────────────────────────────────

export interface SavePageParams {
  content: string;
  existingId?: string;
  /** When set, encrypt under this viewKey (shared doc) instead of owner self. */
  viewKey?: string;
  /** When set, sign the event with this key (recipient-editable shared doc). */
  editKey?: string;
}

export async function savePage(params: SavePageParams): Promise<PageDocument> {
  const signer = await signerManager.getSigner();
  const dTag = params.existingId ?? randomId(6);

  // Owner self-encryption for personal docs; viewKey self-conversation for shared
  // ones — exactly the standalone's encryptContent(content, viewKey?).
  const encrypted = params.viewKey
    ? await encryptWithViewKey(params.viewKey, params.content)
    : await nip44SelfEncrypt(signer, params.content);

  // No plaintext title tag (the standalone keeps the doc fully private; the
  // title is the decrypted first line).
  const template: EventTemplate = {
    kind: PAGES_KINDS.document,
    created_at: Math.floor(Date.now() / 1000),
    // Shared docs add `["a", room]` (v2); personal docs keep the bare `d` tag.
    tags: contentTags(dTag, params.viewKey),
    content: encrypted,
  };

  const signed: Event = params.editKey
    ? finalizeEvent(template, hexToBytes(params.editKey))
    : await signer.signEvent(template);

  await nostrRuntime.publish(RELAYS(), signed);

  return {
    id: dTag,
    address: `${PAGES_KINDS.document}:${signed.pubkey}:${dTag}`,
    title: extractTitle(params.content),
    content: params.content,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    isEncrypted: true,
    viewKey: params.viewKey,
    editKey: params.editKey,
    event: signed,
  };
}

// ── Fetch ───────────────────────────────────────────────

export async function fetchMyPages(viewKeys?: Map<string, string>): Promise<PageSummary[]> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const relays = RELAYS();

  const events = await nostrRuntime.querySync(relays, {
    kinds: [PAGES_KINDS.document],
    authors: [pubkey],
  } as Filter);

  const deletions = await fetchDeletions(relays, [pubkey]);
  const metadata = await fetchAllDocMetadata().catch(() => new Map<string, DocMetadata>());

  // Newest-wins per d-tag, drop deleted.
  const newest = new Map<string, Event>();
  for (const ev of events) {
    if (isPageDeleted(ev, deletions)) continue;
    const dTag = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const prev = newest.get(dTag);
    if (!prev || ev.created_at > prev.created_at) newest.set(dTag, ev);
  }

  const summaries: PageSummary[] = [];
  for (const [dTag, ev] of newest) {
    const address = `${PAGES_KINDS.document}:${ev.pubkey}:${dTag}`;
    const meta = metadata.get(address);
    const viewKey = meta?.viewKey ?? viewKeys?.get(address);
    // Custom title (rename) wins; else owner self-decrypt; else fall back to a known
    // viewKey (docs the owner has shared are re-encrypted under the viewKey, so
    // owner self-decrypt no longer works).
    let title = meta?.title || `Document ${dTag}`;
    if (!meta?.title) {
      try {
        title = extractTitle(await nip44SelfDecrypt(signer, ev.content));
      } catch {
        if (viewKey) {
          try {
            title = extractTitle(await decryptWithViewKey(viewKey, ev.content));
          } catch {
            /* keep fallback title */
          }
        }
      }
    }
    summaries.push({
      id: dTag,
      address,
      title,
      pubkey: ev.pubkey,
      createdAt: ev.created_at,
      isEncrypted: ev.content.length > 0,
      viewKey,
      ...(Array.isArray(meta?.tags) && meta.tags.length > 0 ? { tags: meta.tags } : {}),
      ...(meta?.sharedAs ? { sharedAs: meta.sharedAs } : {}),
    });
  }
  return summaries;
}

export async function fetchPage(
  pubkey: string,
  docId: string,
  viewKey?: string,
): Promise<PageDocument | null> {
  const relays = RELAYS();

  // v2 group document: a viewKey means resolve the tip across every authorized
  // author's slot (roster + mode), not just one author's newest event.
  if (viewKey) {
    const tip = await resolveContentTip(pubkey, docId, viewKey, relays);
    if (tip) {
      let content = tip.content;
      let decrypted = false;
      try {
        content = await decryptWithViewKey(viewKey, tip.content);
        decrypted = true;
      } catch {
        /* return ciphertext if the viewKey is wrong */
      }
      return {
        id: docId,
        address: rootAddress(pubkey, docId),
        title: decrypted ? extractTitle(content) : `Document ${docId}`,
        content,
        pubkey: tip.pubkey,
        createdAt: tip.created_at,
        isEncrypted: !decrypted,
        viewKey,
        event: tip,
      };
    }
  }

  const event = await nostrRuntime.fetchOne(relays, {
    kinds: [PAGES_KINDS.document],
    authors: [pubkey],
    "#d": [docId],
    limit: 1,
  } as Filter);
  if (!event) return null;

  let content = event.content;
  let decrypted = false;
  try {
    content = viewKey
      ? await decryptWithViewKey(viewKey, event.content)
      : await nip44SelfDecrypt(await signerManager.getSigner(), event.content);
    decrypted = true;
  } catch {
    /* fall through to the metadata viewKey */
  }
  // No viewKey supplied and owner self-decrypt failed: the user may hold a granted
  // viewKey in their doc metadata (upstream's shared-doc discovery model).
  if (!decrypted && !viewKey) {
    try {
      const meta = await fetchDocMetadata(`${PAGES_KINDS.document}:${pubkey}:${docId}`);
      if (meta?.viewKey) {
        content = await decryptWithViewKey(meta.viewKey, event.content);
        viewKey = meta.viewKey;
        decrypted = true;
      }
    } catch {
      /* return ciphertext if we can't decrypt */
    }
  }

  return {
    id: docId,
    address: `${PAGES_KINDS.document}:${event.pubkey}:${docId}`,
    title: decrypted ? extractTitle(content) : `Document ${docId}`,
    content,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    isEncrypted: !decrypted,
    viewKey,
    event,
  };
}

// ── v2 group resolution ─────────────────────────────────

/**
 * Fetch the newest roster for a document, decrypting with the viewKey.
 *
 * The owner's roster is stored in the same kind-34579 slot as the legacy
 * self-encrypted metadata, so read both encodings: v2 writes are viewKey-
 * encrypted, v1 writes self-encrypted. Whichever decrypts first wins.
 */
export async function fetchRoster(
  owner: string,
  d: string,
  viewKey: string,
): Promise<DocRoster | null> {
  const signer = await signerManager.getSigner();
  const events = await nostrRuntime.querySync(RELAYS(), {
    kinds: [PAGES_KINDS.docMetadata],
    authors: [owner],
    "#d": [rosterDTag(owner, d)],
  } as Filter);
  if (events.length === 0) return null;
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));

  const fromViewKey = await decodeRosterEvent(newest, viewKey);
  if (fromViewKey) return fromViewKey;
  try {
    return parseRosterPayload(await nip44SelfDecrypt(signer, newest.content));
  } catch {
    return null;
  }
}

/** True when `event.content` decrypts with the viewKey (authorized + not spam). */
async function decryptsWithViewKey(event: Event, viewKey: string): Promise<boolean> {
  try {
    await decryptWithViewKey(viewKey, event.content);
    return true;
  } catch {
    return false;
  }
}

/**
 * The document tip across authors: roster → author set (restricted) or the
 * capability room (open) → newest decryptable content event. Returns null when
 * there is no roster and no readable owner event.
 */
async function resolveContentTip(
  owner: string,
  d: string,
  viewKey: string,
  relays: string[],
): Promise<Event | null> {
  const roster = await fetchRoster(owner, d, viewKey);
  const filter = isOpenRoster(roster)
    ? ({ kinds: [PAGES_KINDS.document], "#a": [collabRoom(viewKey)] } as Filter)
    : ({
        kinds: [PAGES_KINDS.document],
        authors: authorSet(owner, roster),
        "#d": [d],
      } as Filter);

  let candidates: Event[] = [];
  try {
    candidates = await nostrRuntime.querySync(relays, filter);
  } catch {
    return null;
  }
  const readable: Event[] = [];
  for (const event of candidates) {
    if (await decryptsWithViewKey(event, viewKey)) readable.push(event);
  }
  return selectTip(readable);
}

// ── Delete (NIP-09) ─────────────────────────────────────

export async function deletePage(address: string): Promise<void> {
  const signer = await signerManager.getSigner();
  const [kindStr, pubkey, dTag] = address.split(":");

  // e-tag every version of the addressable doc (upstream deleteEvent passes all
  // version ids) so relays can drop the individual events, not just the address.
  let versionIds: string[] = [];
  try {
    const versions = await nostrRuntime.querySync(RELAYS(), {
      kinds: [Number(kindStr)],
      authors: [pubkey],
      "#d": [dTag],
    } as Filter);
    versionIds = versions.map((v: Event) => v.id);
  } catch {
    /* address-only deletion still works */
  }

  const event: EventTemplate = {
    kind: 5,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["a", address],
      ["k", String(PAGES_KINDS.document)],
      ...versionIds.map((id) => ["e", id]),
    ],
    content: "Deleted via Formstr",
  };
  const signed = await signer.signEvent(event);
  await nostrRuntime.publish(RELAYS(), signed);
}

/** NIP-09 deletion index: deleted `a`-addresses → newest deletion time, + deleted e-ids. */
export interface DeletionIndex {
  coordTimes: Map<string, number>;
  ids: Set<string>;
}

export async function fetchDeletions(relays: string[], authors: string[]): Promise<DeletionIndex> {
  const coordTimes = new Map<string, number>();
  const ids = new Set<string>();
  if (authors.length === 0) return { coordTimes, ids };

  const events = await nostrRuntime.querySync(relays, { kinds: [5], authors } as Filter);
  for (const ev of events) {
    for (const tag of ev.tags) {
      if (tag[0] === "a" && tag[1]) {
        const author = tag[1].split(":")[1];
        if (author && author !== ev.pubkey) continue; // same-author guard
        const prev = coordTimes.get(tag[1]) ?? 0;
        if (ev.created_at > prev) coordTimes.set(tag[1], ev.created_at);
      } else if (tag[0] === "e" && tag[1]) {
        ids.add(`${ev.pubkey}:${tag[1]}`);
      }
    }
  }
  return { coordTimes, ids };
}

export function isPageDeleted(event: Event, index: DeletionIndex): boolean {
  if (index.ids.has(`${event.pubkey}:${event.id}`)) return true;
  const dTag = event.tags.find((t) => t[0] === "d")?.[1] ?? "";
  const delTime = index.coordTimes.get(`${event.kind}:${event.pubkey}:${dTag}`);
  return delTime !== undefined && event.created_at <= delTime;
}

// ── Share ───────────────────────────────────────────────

/** Pure builder: `/pages/<naddr>#<nkeys>` for an address + keys. */
export function generateShareLink(address: string, viewKey: string, editKey?: string): ShareResult {
  const [kindStr, pubkey, identifier] = address.split(":");
  const naddr = nip19.naddrEncode({ pubkey, kind: Number(kindStr), identifier });
  const nkeys = encodeNKeys({ viewKey, ...(editKey ? { editKey } : {}) });
  const origin =
    typeof window !== "undefined" && window.location?.origin
      ? window.location.origin
      : "https://formstr.app";
  return { url: `${origin}/pages/${naddr}#${nkeys}`, address, viewKey, editKey };
}

export interface SharePageParams {
  address: string;
  content: string;
  canEdit: boolean;
  /** Reuse an existing viewKey/editKey (re-share) instead of minting fresh ones. */
  viewKey?: string;
  editKey?: string;
}

/**
 * Mint (or reuse) a viewKey (+ editKey iff `canEdit`), re-encrypt the doc under
 * the viewKey, re-sign (with the editKey when can-edit, else the owner), publish,
 * and return the `#nkeys` share link. Mirrors `handleGeneratePrivateLink` +
 * the upstream post-share bookkeeping (record keys in doc metadata; mark the
 * original with `sharedAs`).
 *
 * Edit re-share: when the doc already has a live shared copy (`sharedAs`) with
 * known keys, the existing link is returned WITHOUT republishing — republishing
 * would push our stale local copy over any edits collaborators made through the
 * live link (upstream ShareModal behavior).
 */
export async function sharePage(params: SharePageParams): Promise<ShareResult> {
  const signer = await signerManager.getSigner();
  const [, ownerPubkey, dTag] = params.address.split(":");

  const originalMeta = await fetchDocMetadata(params.address).catch(() => undefined);
  if (params.canEdit && originalMeta?.sharedAs) {
    const sharedMeta = await fetchDocMetadata(originalMeta.sharedAs).catch(() => undefined);
    if (sharedMeta?.viewKey && sharedMeta.editKey) {
      return generateShareLink(originalMeta.sharedAs, sharedMeta.viewKey, sharedMeta.editKey);
    }
  }

  const viewKeyHex = params.viewKey ?? originalMeta?.viewKey ?? generateViewKey().hex;
  const editKeyHex = params.canEdit
    ? (params.editKey ?? originalMeta?.editKey ?? generateViewKey().hex)
    : undefined;

  const encrypted = await encryptWithViewKey(viewKeyHex, params.content);
  const template: EventTemplate = {
    kind: PAGES_KINDS.document,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["d", dTag]],
    content: encrypted,
  };
  const signed: Event = editKeyHex
    ? finalizeEvent(template, hexToBytes(editKeyHex))
    : await signer.signEvent(template);

  await nostrRuntime.publish(RELAYS(), signed);

  const newAddress = `${PAGES_KINDS.document}:${signed.pubkey}:${dTag}`;

  // Record the share keys in doc metadata (upstream addSharedDoc) and, for an
  // edit-share of the user's own doc, mark the original as a backup pointing at
  // the shared copy (upstream setDocSharedAs).
  await saveDocMetadata(newAddress, {
    viewKey: viewKeyHex,
    ...(editKeyHex ? { editKey: editKeyHex } : {}),
  });
  if (editKeyHex && ownerPubkey === (await signer.getPublicKey())) {
    await saveDocMetadata(params.address, { sharedAs: newAddress });
  }

  return generateShareLink(newAddress, viewKeyHex, editKeyHex);
}

// ── v2 group sharing (multi-writer / realtime) ──────────

export interface GroupShareParams {
  address: string;
  /** The current Markdown snapshot to publish under the viewKey. */
  content: string;
  mode?: DocMode;
  /** Initial editor/viewer roster (restricted mode). */
  members?: DocMember[];
  /** Reuse an existing viewKey instead of minting one (idempotent re-share). */
  viewKey?: string;
}

export interface GroupShareResult extends ShareResult {
  mode: DocMode;
  members: DocMember[];
}

/** d-tag of a `33457:owner:d` address; tolerates colons in the identifier. */
function splitAddress(address: string): { owner: string; d: string } | null {
  const parsed = parseRootAddress(address);
  return parsed ? { owner: parsed.owner, d: parsed.d } : null;
}

/**
 * Publish the owner's own version of a group document, encrypted with the shared
 * viewKey and tagged `["a", room]` so open-mode readers find it without knowing
 * the owner's key. Signed by the owner's real signer (v2 keeps per-author slots;
 * only legacy edit-key shares sign with a shared key).
 */
export async function publishGroupContent(
  owner: string,
  d: string,
  viewKey: string,
  content: string,
): Promise<Event> {
  const signer = await signerManager.getSigner();
  if ((await signer.getPublicKey()) !== owner) {
    throw new Error("Only the document owner can publish the root content");
  }
  const signed = await signer.signEvent({
    kind: PAGES_KINDS.document,
    created_at: Math.floor(Date.now() / 1000),
    tags: contentTags(d, viewKey),
    content: await encryptWithViewKey(viewKey, content),
  });
  await nostrRuntime.publish(RELAYS(), signed);
  return signed;
}

/**
 * Write the owner's viewKey-encrypted roster (kind 34579, d = root address).
 * Owner-only. Strictly supersedes the version it read from so a same-second
 * rewrite cannot be dropped by a relay's replaceable-slot check.
 */
export async function saveRoster(
  owner: string,
  d: string,
  viewKey: string,
  roster: DocRoster,
): Promise<void> {
  const signer = await signerManager.getSigner();
  if ((await signer.getPublicKey()) !== owner) {
    throw new Error("Only the document owner can write the roster");
  }
  const dTag = rosterDTag(owner, d);
  const prevEvent = await fetchNewestDocMetadataEvent(dTag);
  const content = await encryptWithViewKey(viewKey, JSON.stringify(roster));
  const signed = await signer.signEvent({
    kind: PAGES_KINDS.docMetadata,
    created_at: Math.max(Math.floor(Date.now() / 1000), (prevEvent?.created_at ?? 0) + 1),
    tags: [["d", dTag]],
    content,
  });
  await nostrRuntime.publish(RELAYS(), signed);
}

/**
 * Turn the user's own document into a v2 group document: re-publish the owner's
 * content under a viewKey and write a roster. `restricted` (default) seeds the
 * editor list; `open` is the capability model (anyone with the link can write).
 * The address is unchanged — the share link is the root naddr + viewKey.
 */
export async function enableGroupSharing(params: GroupShareParams): Promise<GroupShareResult> {
  const ref = splitAddress(params.address);
  if (!ref) throw new Error(`Not a valid document address: ${params.address}`);
  const signer = await signerManager.getSigner();
  if ((await signer.getPublicKey()) !== ref.owner) {
    throw new Error("Only the document owner can share this document");
  }

  const viewKey = params.viewKey ?? generateViewKey().hex;
  const mode = params.mode ?? "restricted";
  const members = params.members ?? [];

  await publishGroupContent(ref.owner, ref.d, viewKey, params.content);
  await saveRoster(ref.owner, ref.d, viewKey, { v: 2, mode, tags: [], members });

  const link = generateShareLink(params.address, viewKey);
  return { ...link, mode, members };
}

/** Replace the roster's member list, preserving mode/title/tags. Owner-only. */
export async function updateRosterMembers(
  owner: string,
  d: string,
  viewKey: string,
  members: DocMember[],
  mode?: DocMode,
): Promise<void> {
  const current = await fetchRoster(owner, d, viewKey);
  await saveRoster(owner, d, viewKey, {
    v: 2,
    mode: mode ?? current?.mode ?? "restricted",
    title: current?.title,
    tags: current?.tags ?? [],
    members,
  });
}

/** Insert or update a member (idempotent by pubkey). */
export function upsertMember(members: DocMember[], pubkey: string, role: DocMember["role"]): DocMember[] {
  const next = members.filter((m) => m.pubkey !== pubkey);
  next.push({ pubkey, role });
  return next;
}

/** Remove a member by pubkey. */
export function removeMember(members: DocMember[], pubkey: string): DocMember[] {
  return members.filter((m) => m.pubkey !== pubkey);
}

// ── Shared-with-me docs (kind-34579 metadata entries with a viewKey) ──

/**
 * Shared docs, upstream model: every doc-metadata entry carrying a `viewKey` is a
 * shared/received doc (`[address, viewKey, editKey?]`). Legacy super-app kind-11234
 * list entries are merged in read-only and migrated into doc metadata best-effort,
 * so they become visible to pages.formstr.app too.
 */
export async function fetchSharedList(): Promise<SharedPageEntry[]> {
  const metadata = await fetchAllDocMetadata();
  const entries: SharedPageEntry[] = [];
  for (const [address, meta] of metadata) {
    if (typeof meta.viewKey !== "string" || !meta.viewKey) continue;
    entries.push(
      typeof meta.editKey === "string" && meta.editKey
        ? [address, meta.viewKey, meta.editKey]
        : [address, meta.viewKey],
    );
  }

  for (const entry of await fetchLegacySharedList()) {
    const [address, viewKey, editKey] = entry;
    if (metadata.get(address)?.viewKey) continue;
    entries.push(entry);
    try {
      await saveDocMetadata(address, { viewKey, ...(editKey ? { editKey } : {}) });
    } catch {
      /* migration is best-effort; the entry is still returned */
    }
  }
  return entries;
}

/** Read the legacy super-app kind-11234 list (migration source only). */
async function fetchLegacySharedList(): Promise<SharedPageEntry[]> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const events = await nostrRuntime.querySync(RELAYS(), {
    kinds: [PAGES_KINDS.sharedPagesList],
    authors: [pubkey],
  } as Filter);
  if (events.length === 0) return [];
  const newest = events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  try {
    const parsed = JSON.parse(await nip44SelfDecrypt(signer, newest.content)) as unknown;
    if (Array.isArray(parsed)) return parsed as SharedPageEntry[];
  } catch {
    /* corrupt / not ours */
  }
  return [];
}

/** Record one shared doc's keys in its kind-34579 metadata (upstream addSharedDoc). */
export async function addSharedPage(entry: SharedPageEntry): Promise<void> {
  const [address, viewKey, editKey] = entry;
  await saveDocMetadata(address, { viewKey, ...(editKey ? { editKey } : {}) });
}

/** Fetch + decrypt every doc shared with the user as summaries. */
export async function fetchSharedPages(): Promise<PageSummary[]> {
  const signer = await signerManager.getSigner();
  const userPubkey = await signer.getPublicKey();
  const entries = await fetchSharedList();
  const out: PageSummary[] = [];
  for (const [address, viewKey, editKey] of entries) {
    const ref = parseRootAddress(address);
    if (!ref) continue;
    const { owner, d: dTag } = ref;
    // The owner's own view-only shares keep the owner's address — they already
    // appear under "my pages" (upstream skips own-pubkey events the same way).
    if (owner === userPubkey) continue;
    const doc = await fetchPage(owner, dTag, viewKey);
    if (!doc) continue;
    // v2: write access is a roster role (or open mode), not an editKey.
    let canEdit = !!editKey;
    if (!canEdit) {
      const roster = await fetchRoster(owner, dTag, viewKey).catch(() => null);
      canEdit =
        isOpenRoster(roster) ||
        !!roster?.members.some((m) => m.pubkey === userPubkey && m.role === "editor");
    }
    out.push({
      id: dTag,
      address: rootAddress(owner, dTag),
      title: doc.title,
      pubkey: owner,
      createdAt: doc.createdAt,
      isEncrypted: doc.isEncrypted,
      shared: true,
      canEdit,
      viewKey,
    });
  }
  return out;
}

// ── Doc metadata (kind 34579) ───────────────────────────

function parseMetadataJson(json: string): DocMetadata | undefined {
  const parsed = JSON.parse(json) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as DocMetadata;
  }
  return undefined;
}

/** Newest decrypted metadata per doc address, for all of the user's docs. */
export async function fetchAllDocMetadata(): Promise<Map<string, DocMetadata>> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const events = await nostrRuntime.querySync(RELAYS(), {
    kinds: [PAGES_KINDS.docMetadata],
    authors: [pubkey],
  } as Filter);

  const newest = new Map<string, Event>();
  for (const ev of events) {
    const addr = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const prev = newest.get(addr);
    if (!prev || ev.created_at > prev.created_at) newest.set(addr, ev);
  }

  const result = new Map<string, DocMetadata>();
  for (const [addr, ev] of newest) {
    try {
      const meta = parseMetadataJson(await nip44SelfDecrypt(signer, ev.content));
      if (meta) result.set(addr, meta);
    } catch {
      /* skip corrupt */
    }
  }
  return result;
}

/** Newest kind-30169 metadata event for one doc address (newest across relays). */
async function fetchNewestDocMetadataEvent(address: string): Promise<Event | undefined> {
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const events = await nostrRuntime.querySync(RELAYS(), {
    kinds: [PAGES_KINDS.docMetadata],
    authors: [pubkey],
    "#d": [address],
  } as Filter);
  if (events.length === 0) return undefined;
  return events.reduce((a, b) => (b.created_at > a.created_at ? b : a));
}

/** Newest decrypted metadata for one doc address. */
export async function fetchDocMetadata(address: string): Promise<DocMetadata | undefined> {
  const signer = await signerManager.getSigner();
  const newest = await fetchNewestDocMetadataEvent(address);
  if (!newest) return undefined;
  try {
    return parseMetadataJson(await nip44SelfDecrypt(signer, newest.content));
  } catch {
    return undefined;
  }
}

/**
 * Read-merge-write one doc's metadata. NEVER write a bare patch: upstream stores
 * `viewKey`/`editKey`/`sharedAs`/`title` in the same object, so a blind overwrite
 * destroys the keys that grant access to a shared doc.
 */
export async function saveDocMetadata(
  address: string,
  patch: Partial<DocMetadata>,
): Promise<DocMetadata> {
  const signer = await signerManager.getSigner();
  const prevEvent = await fetchNewestDocMetadataEvent(address);
  let existing: DocMetadata = {};
  if (prevEvent) {
    try {
      existing = parseMetadataJson(await nip44SelfDecrypt(signer, prevEvent.content)) ?? {};
    } catch {
      /* undecryptable prior metadata — merge onto empty, but still supersede it below */
    }
  }
  const merged: DocMetadata = { ...existing, ...patch };
  // Upstream nostr-docs types `tags` as a required field and reads `meta.tags.length`
  // unguarded (DocMetadataContext): a metadata object with no `tags` key makes
  // pages.formstr.app throw and drop ALL doc titles/tags/sharedAs. Always emit one.
  if (!Array.isArray(merged.tags)) merged.tags = [];

  const content = await nip44SelfEncrypt(signer, JSON.stringify(merged));
  const signed = await signer.signEvent({
    kind: PAGES_KINDS.docMetadata,
    // Strictly supersede the event this merge was read from: two saves in the
    // same second otherwise tie on created_at and NIP-01 tie-breaking (lowest
    // id wins) can resurrect the stale copy — losing a just-saved viewKey/title.
    created_at: Math.max(Math.floor(Date.now() / 1000), (prevEvent?.created_at ?? 0) + 1),
    tags: [["d", address]],
    content,
  });
  await nostrRuntime.publish(RELAYS(), signed);
  return merged;
}

// ── Doc tags / titles (metadata views) ──────────────────

export async function fetchDocTags(addresses: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  if (addresses.length === 0) return result;
  const signer = await signerManager.getSigner();
  const pubkey = await signer.getPublicKey();
  const events = await nostrRuntime.querySync(RELAYS(), {
    kinds: [PAGES_KINDS.docMetadata],
    authors: [pubkey],
    "#d": addresses,
  } as Filter);

  const newest = new Map<string, Event>();
  for (const ev of events) {
    const addr = ev.tags.find((t) => t[0] === "d")?.[1] ?? "";
    const prev = newest.get(addr);
    if (!prev || ev.created_at > prev.created_at) newest.set(addr, ev);
  }
  for (const [addr, ev] of newest) {
    try {
      const meta = parseMetadataJson(await nip44SelfDecrypt(signer, ev.content));
      if (meta && Array.isArray(meta.tags)) result.set(addr, meta.tags);
    } catch {
      /* skip corrupt */
    }
  }
  return result;
}

export async function setDocTags(address: string, tags: string[]): Promise<void> {
  await saveDocMetadata(address, { tags });
}

/** Set/clear a custom display title (rename) — blank clears it (upstream semantics). */
export async function setDocTitle(address: string, title: string): Promise<void> {
  await saveDocMetadata(address, { title: title || undefined });
}

/** Mark a doc as a backup of its shared (editKey-signed) copy. */
export async function setDocSharedAs(address: string, sharedAs: string): Promise<void> {
  await saveDocMetadata(address, { sharedAs });
}

// ── Helpers ─────────────────────────────────────────────

function extractTitle(markdown: string): string {
  const firstLine = markdown.trim().split("\n")[0] ?? "";
  return firstLine.replace(/^#+\s*/, "").trim() || "Untitled";
}

function randomId(length: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
    result += chars[byte % chars.length];
  }
  return result;
}
