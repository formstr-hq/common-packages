import type { Event } from "nostr-tools";

/**
 * Ports of kanbanstr's own parsers at commit bf36bd8. Copied in structure, not
 * paraphrased: their behaviour is the interop contract. Do not "improve" these —
 * if they look wrong, that is the point.
 *
 * Board: src/lib/stores/kanban.ts:131-174
 * Card:  src/lib/stores/kanban.ts:506-561
 */

export function parseBoardLikeKanbanstr(event: Event) {
  const titleTag = event.tags.find((t) => t[0] === "title");
  const descTag = event.tags.find((t) => t[0] === "description");
  const dTag = event.tags.find((t) => t[0] === "d");

  const columns = event.tags
    .filter((t) => t[0] === "col")
    .map((t) => ({ id: t[1], name: t[2], order: parseInt(t[3]) }));

  const hasNoZapTag = event.tags.some((t) => t[0] === "nozap");
  const maintainers = event.tags.filter((t) => t[0] === "p").map((t) => t[1]);

  return {
    id: dTag ? dTag[1] : event.id,
    pubkey: event.pubkey,
    title: titleTag ? titleTag[1] : "Untitled Board",
    description: descTag ? descTag[1] : "",
    columns,
    isNoZapBoard: hasNoZapTag,
    maintainers,
  };
}

export function parseCardLikeKanbanstr(event: Event) {
  const titleTag = event.tags.find((t) => t[0] === "title");
  const descTag = event.tags.find((t) => t[0] === "description");
  const statusTag = event.tags.find((t) => t[0] === "s");
  const rankTag = event.tags.find((t) => t[0] === "rank");

  const attachments = event.tags.filter((t) => t[0] === "u").map((t) => t[1]);
  // Note: kanbanstr does NOT dedupe p/zap, so an assignee appears twice.
  const assignees = event.tags.filter((t) => t[0] === "p" || t[0] === "zap").map((t) => t[1]);
  const aTags = event.tags.filter((t) => t[0] === "a").map((t) => t[1]);
  const tTags = event.tags.filter((t) => t[0] === "t").map((t) => t[1]);
  const iTags = event.tags.filter((t) => t[0] === "i");
  const binnedTag = event.tags.find((t) => t[0] === "binned");

  return {
    dTag: event.tags.find((t) => t[0] === "d")?.[1] ?? event.id,
    pubkey: event.pubkey,
    title: titleTag ? titleTag[1] : "Untitled Card",
    description: descTag ? descTag[1] : "",
    status: statusTag ? statusTag[1] : "To Do",
    order: rankTag ? parseInt(rankTag[1]) : 0,
    attachments,
    assignees,
    aTags,
    tTags,
    iTags,
    binned: binnedTag ? true : false,
  };
}
