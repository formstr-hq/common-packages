import {
  canEditCards,
  type CardDraft,
  type Column as ColumnModel,
  type KanbanBoard,
  type KanbanCard,
} from "@formstr/kanban-sdk";
import {
  DndContext,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useMemo, useState } from "react";

import { useBoard } from "../hooks/useBoard";
import { cardsInColumn, useCards } from "../hooks/useCards";
import { useApp } from "../nostr/AppContext";
import { navigate } from "../router";
import { useToast } from "../ui/Toast";
import { CardDialog } from "./CardDialog";
import { Column } from "./Column";
import { MembersPanel } from "./MembersPanel";
import { ShareBar } from "./ShareBar";

/**
 * Public boards address columns by name (that is what kanbanstr writes); private
 * boards by column id, so renaming a column does not strand its cards.
 */
export function statusOf(board: KanbanBoard, column: ColumnModel): string {
  return board.isPrivate ? column.id : column.name;
}

export function BoardPage({ coordinate }: { coordinate: string }) {
  const { sdk, account } = useApp();
  const toast = useToast();
  const board = useBoard(coordinate);
  const cards = useCards(board.data);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [moving, setMoving] = useState(false);

  const sensors = useSensors(
    // A small threshold, or every click on a card registers as a drag and the
    // card dialog never opens.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const columns = useMemo(
    () => [...(board.data?.columns ?? [])].sort((a, b) => a.order - b.order),
    [board.data],
  );

  const canWrite = board.data && account ? canEditCards(board.data, account.pubkey) : false;
  const openCard = cards.data.find((c) => c.id === openCardId) ?? null;

  const orphans = useMemo(() => {
    if (!board.data) return [];
    const known = new Set(columns.map((column) => statusOf(board.data!, column)));
    return cards.data.filter((card) => !card.status || !known.has(card.status));
  }, [board.data, columns, cards.data]);

  async function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || !board.data) return;
    const cardId = String(active.id);
    const overId = String(over.id);
    if (overId === cardId) return;

    let targetStatus: string | undefined;
    let targetIndex = 0;

    if (overId.startsWith("column:")) {
      const column = columns.find((c) => `column:${c.id}` === overId);
      if (!column) return;
      targetStatus = statusOf(board.data, column);
      targetIndex = cardsInColumn(cards.data, targetStatus).length;
    } else {
      const overCard = cards.data.find((c) => c.id === overId);
      if (!overCard?.status) return;
      targetStatus = overCard.status;
      targetIndex = cardsInColumn(cards.data, targetStatus).findIndex((c) => c.id === overId);
    }
    if (!targetStatus) return;

    setMoving(true);
    try {
      // moveCard recomputes the rank from its neighbours and republishes the
      // card — the whole card, since ranks live on cards, not on the board.
      await sdk!.moveCard(board.data, cards.data, cardId, targetStatus, targetIndex);
      await cards.refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setMoving(false);
    }
  }

  async function addCard(status: string, draft: CardDraft) {
    try {
      await sdk!.createCard(board.data!, { ...draft, status });
      toast.notify("Card published", "success");
      setAddingTo(null);
      await cards.refresh();
    } catch (error) {
      toast.fail(error);
    }
  }

  if (board.loading && !board.data) return <p className="muted">Loading board…</p>;
  if (board.error) {
    return (
      <div className="panel">
        <p className="error">{String((board.error as Error).message ?? board.error)}</p>
        <button onClick={() => navigate("#/")} type="button">
          Back to boards
        </button>
      </div>
    );
  }
  if (!board.data) {
    return (
      <div className="panel">
        <p className="muted">
          Not found on these relays. Addressable events are per-relay — try the relay the board was
          written to.
        </p>
        <button onClick={() => navigate("#/")} type="button">
          Back to boards
        </button>
      </div>
    );
  }

  const current = board.data;

  return (
    <div className="board-page">
      <div className="board-head">
        <div>
          <span className={current.isPrivate ? "badge badge-private" : "badge"}>
            {current.isPrivate ? "private · 32301" : "public · 30301"}
          </span>
          <h2>{current.title || "(untitled)"}</h2>
          <p className="muted small">{current.description}</p>
        </div>
        <div className="row-actions">
          <button className="link" onClick={() => void cards.refresh()} type="button">
            {cards.loading || moving ? "Syncing…" : "Refresh"}
          </button>
          {current.isPrivate && (
            <button className="link" onClick={() => setShowMembers(true)} type="button">
              Members ({current.maintainers.length + current.members.length + 1})
            </button>
          )}
          <button className="link" onClick={() => navigate("#/")} type="button">
            All boards
          </button>
        </div>
      </div>

      <ShareBar board={current} />

      {!canWrite && (
        <p className="notice">
          You can read and comment here, but not write cards — only the owner and maintainers can.
        </p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={onDragEnd}>
        <div className="columns">
          {columns.map((column) => (
            <Column
              key={column.id}
              column={column}
              cards={cardsInColumn(cards.data, statusOf(current, column))}
              canWrite={canWrite}
              onAdd={() => setAddingTo(statusOf(current, column))}
              onOpen={(card) => setOpenCardId(card.id)}
            />
          ))}

          {orphans.length > 0 && (
            <section className="column column-orphans">
              <header className="column-head">
                <h3>No column</h3>
                <span className="muted small">{orphans.length}</span>
              </header>
              <div className="column-cards">
                {orphans.map((card: KanbanCard) => (
                  <button key={card.id} className="card" onClick={() => setOpenCardId(card.id)}>
                    <strong>{card.title || "(untitled)"}</strong>
                    <span className="muted small">status: {card.status ?? "(none)"}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </DndContext>

      {addingTo !== null && (
        <CardDialog
          board={current}
          card={null}
          status={addingTo}
          canWrite={canWrite}
          onClose={() => setAddingTo(null)}
          onSave={(draft) => addCard(addingTo, draft)}
          onChanged={() => void cards.refresh()}
        />
      )}

      {openCard && (
        <CardDialog
          board={current}
          card={openCard}
          status={openCard.status ?? ""}
          canWrite={canWrite}
          onClose={() => setOpenCardId(null)}
          onSave={async (draft) => {
            try {
              await sdk!.updateCard(current, openCard, draft);
              toast.notify("Card updated", "success");
              setOpenCardId(null);
              await cards.refresh();
            } catch (error) {
              toast.fail(error);
            }
          }}
          onDelete={async () => {
            try {
              await sdk!.deleteCard(openCard);
              toast.notify("Delete requested (kind 5) — relays honour it at their discretion");
              setOpenCardId(null);
              await cards.refresh();
            } catch (error) {
              toast.fail(error);
            }
          }}
          onChanged={() => void cards.refresh()}
        />
      )}

      {showMembers && (
        <MembersPanel
          board={current}
          onClose={() => setShowMembers(false)}
          onChanged={() => {
            void board.refresh();
            void cards.refresh();
          }}
        />
      )}
    </div>
  );
}
