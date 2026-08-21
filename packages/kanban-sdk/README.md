# @formstr/kanban-sdk

Headless TypeScript SDK for Nostr Kanban boards ([NIP-100](https://github.com/nostr-protocol/nips/pull/1665)), byte-compatible with [kanbanstr.com](https://kanbanstr.com).

Ships no UI and owns no storage or keys — you bring a signer, call methods, and get plain objects back.

```bash
npm install @formstr/kanban-sdk
```

## Quick start

```ts
import { KanbanSDK } from "@formstr/kanban-sdk";

const sdk = new KanbanSDK({ signer });

const board = await sdk.createBoard({
  title: "Q3 Roadmap",
  columns: [
    { id: "todo", name: "To Do", order: 0 },
    { id: "doing", name: "In Progress", order: 1 },
    { id: "done", name: "Done", order: 2 },
  ],
  participants: [colleagueHexPubkey],
});

await sdk.createCard(board, { title: "Ship the SDK", status: "To Do" });

const cards = await sdk.fetchCards(board);
const moved = await sdk.moveCard(board, cards, cards[0].id, "In Progress", 0);

sdk.dispose();
```

Without a signer the SDK still reads public boards; writes throw `SignerRequiredError`.

## Status

Public NIP-100 boards only. Private encrypted boards (NIP-100E) land in a later release — see `kanban/docs/05-private-kanban-spec.md`.

## Who may write what

Nostr binds every event to the key that signed it, and the SDK enforces the same
boundaries a relay would rather than pretending a write succeeded:

There are three roles. The **creator** is the key that signed the board event.
**Admins** are the keys the creator has promoted. **Participants** are everyone
else with write access.

| Operation | Allowed for |
| --- | --- |
| `deleteBoard`, key rotation, `promoteToAdmin` / `demoteAdmin` | the creator only — the board is an addressable single-owner event, and the admin list it carries is the one thing every other guard rests on |
| `updateBoard` — columns, title, description, roster | the creator and its admins. The creator writes the board event; an admin writes a patch, because re-signing the board would fork it to their own coordinate |
| `leaveBoard` | anyone: it unlinks the board from your own lists and touches nothing else |
| create / update / move / bin a card | the creator, admins and participants |
| comment | all of those, plus viewers carried over from 0.1.x |
| `deleteCard` / `deleteComment` | whoever **signed that version** — NIP-09 recognises no other deletion |

### How an admin edits a board they do not own

The board event is addressable at `kind:pubkey:d`, so only its creator can
publish a new version. An admin publishes a **patch** instead — kind 30303
public, 32305 private — at their own coordinate, carrying just their delta.
Every reader folds base plus patches into the board it shows.

Three rules make that safe, and all three are checked on read rather than
trusted to the writer:

- A patch's `admin` rows are ignored, so an admin cannot promote a peer or
  escalate past the creator. The codec does not even parse one.
- A patch cannot remove the creator or another admin.
- The fold reads the base board's *current* admin list, so demoting somebody
  retires every patch they ever wrote — no tombstone, no cooperation from them.

When the creator saves the board, the SDK folds the live state into the board
event and stamps `["baked", <unix>]` on it. That retires every existing patch in
one tag (a patch applies only if `created_at > baked`) and leaves the board event
a complete, ordinary NIP-100 board again — which is what keeps kanbanstr.com in
sync. Until a creator saves, kanbanstr sees the creator's version alone.

### What an admin's removal does not do

`removeMember` returns `{ board, rotated }`. Rotation republishes the board
event, so an admin cannot do it: their removal takes the person off the roster
and leaves them holding a working view key. Check `rotated` before telling
anyone access was revoked.

### Upgrading from 0.1.x

`KanbanBoard.maintainers` and `.members` are gone, replaced by `.admins`,
`.participants` and `.legacyViewers`. The wire format is compatible in both
directions: admins are `p`-tagged as well as `admin`-tagged, so older clients
grant them card writes, and `["member", …]` tags written by 0.1.x are still read
into `legacyViewers`. Nothing writes a `member` tag any more — the Viewer role
was enforced by no code path, in this SDK or any other.

Editing someone else's card is allowed and records `original-author` in the
payload, so authorship does not transfer to whoever saved last. To take down a
card you did not write, use `binCard` — a reversible edit every reader honours —
because a tombstone you sign for someone else's event is ignored.

## Notes on compatibility

- Assignees are written to **both** `p` and `zap` tags, because kanbanstr reads either and routes zaps via `zap`.
- Non-spec tags `binned`, `nozap`, and `t` are preserved and understood.
- v0 legacy boards (columns in JSON `content`) are readable but never written.
- Every edit merges into the fetched event rather than rebuilding from the model, so tags written by other clients survive a round trip. In particular `k` / `e` / `refs/board` / `refs/card` are never in the managed set, so editing a tracker card cannot stop it tracking.
- Card resolution follows NIP-01 exactly: newest `created_at`, ties broken by lowest event id. Republishes use `created_at = max(now, previous + 1)` so two writes in the same second cannot tie.

## Development

```bash
pnpm build      # tsup → dist (ESM + CJS + d.ts)
pnpm typecheck
pnpm test
```

`test/interop.test.ts` runs this SDK's output through **ports of kanbanstr's actual parsers**, copied rather than paraphrased, from commit `bf36bd8`. If you change a wire shape, that suite is what tells you whether you just desynced the two clients. If it fails, fix the codec — never the ported parser.
