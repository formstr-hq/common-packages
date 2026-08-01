import { canComment, type KanbanBoard } from "@formstr/kanban-sdk";
import { nip19 } from "nostr-tools";
import { useState } from "react";

import { threadComments, useComments } from "../hooks/useComments";
import { useApp } from "../nostr/AppContext";
import { useToast } from "../ui/Toast";

function who(pubkey: string): string {
  return `${nip19.npubEncode(pubkey).slice(0, 12)}…`;
}

export function CommentThread({ board, cardId }: { board: KanbanBoard; cardId: string }) {
  const { sdk, account } = useApp();
  const toast = useToast();
  const comments = useComments(board, cardId);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allowed = account ? canComment(board, account.pubkey) : false;

  async function submit() {
    setBusy(true);
    try {
      await sdk!.createComment(board, cardId, { content: text, replyTo: replyTo ?? undefined });
      setText("");
      setReplyTo(null);
      await comments.refresh();
    } catch (error) {
      toast.fail(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="comments">
      <div className="panel-head">
        <h3>Comments</h3>
        <button className="link" onClick={() => void comments.refresh()} type="button">
          {comments.loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {comments.data.length === 0 && !comments.loading && (
        <p className="muted small">No comments yet.</p>
      )}

      <ul className="comment-list">
        {threadComments(comments.data).map(({ comment, replies }) => (
          <li key={comment.id}>
            <div className="comment">
              <div className="muted small">
                {who(comment.authorPubkey)} · {new Date(comment.createdAt * 1000).toLocaleString()}
                {comment.rotated && " · rotated copy"}
              </div>
              <p>{comment.content}</p>
              {allowed && (
                <button className="link" onClick={() => setReplyTo(comment.id)} type="button">
                  Reply
                </button>
              )}
            </div>
            {replies.length > 0 && (
              <ul className="comment-replies">
                {replies.map((reply) => (
                  <li key={reply.id} className="comment">
                    <div className="muted small">
                      {who(reply.authorPubkey)} ·{" "}
                      {new Date(reply.createdAt * 1000).toLocaleString()}
                    </div>
                    <p>{reply.content}</p>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>

      {allowed ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {replyTo && (
            <div className="muted small">
              Replying to a comment ·{" "}
              <button className="link" onClick={() => setReplyTo(null)} type="button">
                cancel
              </button>
            </div>
          )}
          <textarea
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Comment (encrypted under the board view key on private boards)"
            required
          />
          <button disabled={busy} type="submit">
            {busy ? "Publishing…" : "Comment"}
          </button>
        </form>
      ) : (
        <p className="muted small">You are not a member of this board, so you cannot comment.</p>
      )}
    </section>
  );
}
