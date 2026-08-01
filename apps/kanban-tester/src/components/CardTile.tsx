import type { KanbanCard } from "@formstr/kanban-sdk";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { nip19 } from "nostr-tools";

export function CardTile({ card, onOpen }: { card: KanbanCard; onOpen(): void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? "card card-dragging" : "card"}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={onOpen}
    >
      <strong>{card.title || "(untitled)"}</strong>
      {card.description && <p className="muted small clamp">{card.description}</p>}
      <div className="card-meta">
        {card.labels.map((label) => (
          <span key={label} className="chip">
            {label}
          </span>
        ))}
        {card.assignees.map((pubkey) => (
          <span key={pubkey} className="chip chip-muted">
            {nip19.npubEncode(pubkey).slice(0, 10)}…
          </span>
        ))}
        {/* A rotation re-signs other people's cards; without this the board would
            silently attribute every card to whoever rotated last. */}
        {card.rotated && <span className="chip chip-muted">rotated copy</span>}
      </div>
    </div>
  );
}
