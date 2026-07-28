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
