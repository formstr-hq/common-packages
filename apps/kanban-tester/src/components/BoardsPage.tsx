import { boardCoordinate, type BoardDraft, type KanbanBoard } from "@formstr/kanban-sdk";
import { useState } from "react";

import { useBoards } from "../hooks/useBoards";
import { useApp } from "../nostr/AppContext";
import { boardHref, navigate } from "../router";
import { useToast } from "../ui/Toast";
import { InvitationsInbox } from "./InvitationsInbox";
import { NewBoardDialog } from "./NewBoardDialog";

function BoardGroup({ title, boards, empty }: { title: string; boards: KanbanBoard[]; empty: string }) {
  if (boards.length === 0) return <p className="muted small">{empty}</p>;
  return (
    <>
      <h3>{title}</h3>
      <ul className="board-grid">
        {boards.map((board) => (
          <li key={boardCoordinate(board)}>
            <button className="board-card" onClick={() => navigate(boardHref(boardCoordinate(board)))}>
              <span className={board.isPrivate ? "badge badge-private" : "badge"}>
                {board.isPrivate ? "private · 32301" : "public · 30301"}
              </span>
              <strong>{board.title || "(untitled)"}</strong>
              <span className="muted small">{board.description}</span>
              <span className="muted small">
                {board.columns.length} columns · {board.maintainers.length} maintainers
                {board.members.length > 0 && ` · ${board.members.length} members`}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function BoardsPage() {
  const { sdk } = useApp();
  const toast = useToast();
  const boards = useBoards();
  const [creating, setCreating] = useState(false);

  async function create(draft: BoardDraft) {
    try {
      const board = await sdk!.createBoard(draft);
      toast.notify(draft.private ? "Private board published" : "Public board published", "success");
      setCreating(false);
      await boards.refresh();
      navigate(boardHref(boardCoordinate(board)));
    } catch (error) {
      toast.fail(error);
    }
  }

  return (
    <div className="boards-page">
      <section className="panel">
        <div className="panel-head">
          <h2>Boards</h2>
          <div className="row-actions">
            <button className="link" onClick={() => void boards.refresh()} type="button">
              {boards.loading ? "Loading…" : "Refresh"}
            </button>
            <button onClick={() => setCreating(true)} type="button">
              New board
            </button>
          </div>
        </div>

        <BoardGroup
          title="Private"
          boards={boards.data.privateBoards}
          empty="No private boards — they are found through your board lists, which is where their view keys live."
        />
        <BoardGroup title="Public — yours" boards={boards.data.own} empty="No public boards yet." />
        <BoardGroup
          title="Public — you maintain"
          boards={boards.data.shared}
          empty="No public boards name you as a maintainer."
        />
      </section>

      <InvitationsInbox onAccepted={() => void boards.refresh()} />

      {creating && <NewBoardDialog onClose={() => setCreating(false)} onCreate={create} />}
    </div>
  );
}
