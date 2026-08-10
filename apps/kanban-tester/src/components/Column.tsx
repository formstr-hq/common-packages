import type { Column as ColumnModel, KanbanCard } from "@formstr/kanban-sdk";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import { CardTile } from "./CardTile";

export function Column({
  column,
  cards,
  canWrite,
  onAdd,
  onOpen,
}: {
  column: ColumnModel;
  cards: KanbanCard[];
  canWrite: boolean;
  onAdd(): void;
  onOpen(card: KanbanCard): void;
}) {
  // Droppable in its own right, so an empty column is still a valid drop target.
  const { setNodeRef, isOver } = useDroppable({ id: `column:${column.id}` });

  return (
    <section className={isOver ? "column column-over" : "column"} ref={setNodeRef}>
      <header className="column-head">
        <h3>{column.name}</h3>
        <span className="muted small">{cards.length}</span>
      </header>

      <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <div className="column-cards">
          {cards.map((card) => (
            <CardTile key={card.id} card={card} onOpen={() => onOpen(card)} />
          ))}
        </div>
      </SortableContext>

      {canWrite && (
        <button className="link column-add" onClick={onAdd} type="button">
          + Add card
        </button>
      )}
    </section>
  );
}
