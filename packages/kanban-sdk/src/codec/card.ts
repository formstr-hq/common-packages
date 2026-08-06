import type { Event } from "nostr-tools";

import type { CardDraft, CardLink, KanbanCard, TrackedRef } from "../types";

/**
 * Tags this codec owns; see BOARD_MANAGED_TAGS for why merging matters.
 *
 * Deliberately excludes `k`, `e`, `refs/board`, `refs/card`, so a tracker card
 * keeps tracking across an edit. Rewriting those away is kanbanstr's silent
 * data-loss bug (kanban/docs/03-kanbanstr-review.md §6.2).
 */
export const CARD_MANAGED_TAGS = [
  "d",
  "title",
  "description",
  "alt",
  "s",
  "rank",
  "a",
  "u",
  "t",
  "p",
  "zap",
  "i",
  "binned",
] as const;

export function buildCardLinkTag(link: CardLink): string[] {
  return [
    "i",
    `kanban:${link.boardPubkey}:${link.boardDTag}:${link.cardDTag}`,
    link.forwardLabel,
    link.reverseLabel,
  ];
}

export function parseCardLink(tag: string[]): CardLink | null {
  if (tag[0] !== "i" || !tag[1]?.startsWith("kanban:")) return null;
  const parts = tag[1].split(":");
  if (parts.length !== 4) return null;
  const [, boardPubkey, boardDTag, cardDTag] = parts;
  return {
    boardPubkey,
    boardDTag,
    cardDTag,
    forwardLabel: tag[2] ?? "",
    reverseLabel: tag[3] ?? "",
  };
}

export function buildPublicCardTags(
  draft: CardDraft,
  dTag: string,
  boardCoordinate: string,
  rank: number,
): string[][] {
  const tags: string[][] = [
    ["d", dTag],
    ["title", draft.title],
    ["description", draft.description ?? ""],
    ["alt", `A card titled ${draft.title}`],
    ["rank", String(rank)],
    ["a", boardCoordinate],
  ];

  if (draft.status) tags.push(["s", draft.status]);
  for (const url of draft.attachments ?? []) tags.push(["u", url]);
  for (const label of draft.labels ?? []) tags.push(["t", label]);

  // kanbanstr writes assignees twice so zaps route to them. Match it exactly.
  for (const assignee of draft.assignees ?? []) {
    tags.push(["zap", assignee]);
    tags.push(["p", assignee]);
  }

  for (const link of draft.links ?? []) tags.push(buildCardLinkTag(link));

  // Host-owned passthrough tags, written verbatim. See CardDraft.extraTags.
  for (const tag of draft.extraTags ?? []) tags.push(tag);

  return tags;
}

function parseTrackedRef(event: Event, trackedKind: number): TrackedRef {
  if (trackedKind === 30302) {
    return {
      boardCoordinate: event.tags.find((t) => t[0] === "refs/board")?.[1],
      cardDTag: event.tags.find((t) => t[0] === "refs/card")?.[1],
    };
  }
  return { eventId: event.tags.find((t) => t[0] === "e")?.[1] };
}

export function parsePublicCard(event: Event): KanbanCard | null {
  const id = event.tags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;

  const rawRank = event.tags.find((t) => t[0] === "rank")?.[1];
  const parsedRank = rawRank === undefined ? Number.NaN : Number.parseFloat(rawRank);

  const assignees = [
    ...new Set(event.tags.filter((t) => t[0] === "p" || t[0] === "zap").map((t) => t[1])),
  ];

  const rawTrackedKind = event.tags.find((t) => t[0] === "k")?.[1];
  const trackedKind = rawTrackedKind ? Number.parseInt(rawTrackedKind, 10) : undefined;

  return {
    id,
    pubkey: event.pubkey,
    // Public cards are never rotated: there is no key to rotate.
    authorPubkey: event.pubkey,
    rotated: false,
    eventId: event.id,
    boardCoordinate: event.tags.find((t) => t[0] === "a")?.[1] ?? "",
    title: event.tags.find((t) => t[0] === "title")?.[1] ?? "Untitled Card",
    description: event.tags.find((t) => t[0] === "description")?.[1] ?? "",
    status: event.tags.find((t) => t[0] === "s")?.[1],
    rank: Number.isNaN(parsedRank) ? 0 : parsedRank,
    attachments: event.tags.filter((t) => t[0] === "u").map((t) => t[1]),
    assignees,
    labels: event.tags.filter((t) => t[0] === "t").map((t) => t[1]),
    links: event.tags.map(parseCardLink).filter((link): link is CardLink => link !== null),
    binned: event.tags.some((t) => t[0] === "binned"),
    isPrivate: false,
    createdAt: event.created_at,
    trackedKind,
    trackedRef: trackedKind === undefined ? undefined : parseTrackedRef(event, trackedKind),
    rawTags: event.tags,
  };
}

/**
 * Inner tags the private card codec owns.
 *
 * Excludes `k`, `e`, `refs/board`, `refs/card` for the same reason the public
 * list does — a tracker card must keep tracking across an edit. Also excludes
 * `binned`: a soft-deleted card that silently un-bins itself on the next edit is
 * worse than one that stays binned.
 */
export const PRIVATE_CARD_MANAGED_TAGS = [
  "d",
  "a",
  "title",
  "description",
  "rank",
  "s",
  "u",
  "t",
  "p",
  "i",
] as const;

/** The inner tag array of a private card, to be NIP-44'd under the BOARD's view key. */
export function buildPrivateCardTags(
  draft: CardDraft,
  dTag: string,
  boardCoordinate: string,
  rank: number,
): string[][] {
  const tags: string[][] = [
    ["d", dTag],
    // `a` lives inside the payload: the public `b` pointer replaces it for lookup,
    // but a decrypted card must still say which board it claims to belong to so
    // the reader can check it (doc 05 §7 step 2).
    ["a", boardCoordinate],
    ["title", draft.title],
    ["description", draft.description ?? ""],
    ["rank", String(rank)],
  ];

  // `s` is the column ID, not its name. Renaming a column is then a single board
  // edit instead of a bulk card rewrite (doc 05 §4).
  if (draft.status) tags.push(["s", draft.status]);
  for (const url of draft.attachments ?? []) tags.push(["u", url]);
  for (const label of draft.labels ?? []) tags.push(["t", label]);
  // No `zap` duplication: that convention exists so kanbanstr can route zaps, and
  // kanbanstr cannot read a private card at all.
  for (const assignee of draft.assignees ?? []) tags.push(["p", assignee]);
  for (const link of draft.links ?? []) tags.push(buildCardLinkTag(link));

  // Host-owned passthrough tags, written verbatim inside the encrypted payload.
  for (const tag of draft.extraTags ?? []) tags.push(tag);

  return tags;
}

export function parsePrivateCard(event: Event, innerTags: string[][]): KanbanCard | null {
  const id = innerTags.find((t) => t[0] === "d")?.[1];
  if (!id) return null;
  if (event.tags.find((t) => t[0] === "d")?.[1] !== id) return null;

  const boardCoordinate = innerTags.find((t) => t[0] === "a")?.[1];
  if (!boardCoordinate) return null;

  const rawRank = innerTags.find((t) => t[0] === "rank")?.[1];
  const parsedRank = rawRank === undefined ? Number.NaN : Number.parseFloat(rawRank);

  const rawTrackedKind = innerTags.find((t) => t[0] === "k")?.[1];
  const trackedKind = rawTrackedKind ? Number.parseInt(rawTrackedKind, 10) : undefined;

  // A rotation republishes other people's cards under the rotator's pubkey
  // (doc 05 §8), so the payload is where the real author survives.
  const rotatedAuthor = innerTags.find((t) => t[0] === "rotated-author")?.[1];

  return {
    id,
    pubkey: event.pubkey,
    authorPubkey: rotatedAuthor ?? event.pubkey,
    rotated: rotatedAuthor !== undefined,
    eventId: event.id,
    boardCoordinate,
    title: innerTags.find((t) => t[0] === "title")?.[1] ?? "Untitled Card",
    description: innerTags.find((t) => t[0] === "description")?.[1] ?? "",
    status: innerTags.find((t) => t[0] === "s")?.[1],
    rank: Number.isNaN(parsedRank) ? 0 : parsedRank,
    attachments: innerTags.filter((t) => t[0] === "u").map((t) => t[1]),
    assignees: [...new Set(innerTags.filter((t) => t[0] === "p").map((t) => t[1]))],
    labels: innerTags.filter((t) => t[0] === "t").map((t) => t[1]),
    links: innerTags.map(parseCardLink).filter((link): link is CardLink => link !== null),
    binned: innerTags.some((t) => t[0] === "binned"),
    isPrivate: true,
    createdAt: event.created_at,
    trackedKind,
    trackedRef: trackedKind === undefined ? undefined : parseTrackedInnerRef(innerTags, trackedKind),
    rawTags: innerTags,
  };
}

/** Tracker refs of a private card live in the payload, not the event tags. */
function parseTrackedInnerRef(innerTags: string[][], trackedKind: number): TrackedRef {
  if (trackedKind === 30302 || trackedKind === 32302) {
    return {
      boardCoordinate: innerTags.find((t) => t[0] === "refs/board")?.[1],
      cardDTag: innerTags.find((t) => t[0] === "refs/card")?.[1],
    };
  }
  return { eventId: innerTags.find((t) => t[0] === "e")?.[1] };
}
