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
  maintainers: [colleagueHexPubkey],
});

await sdk.createCard(board, { title: "Ship the SDK", status: "To Do" });

const cards = await sdk.fetchCards(board);
const moved = await sdk.moveCard(board, cards, cards[0].id, "In Progress", 0);

sdk.dispose();
```

Without a signer the SDK still reads public boards; writes throw `SignerRequiredError`.

## Status

Public NIP-100 boards only. Private encrypted boards (NIP-100E) land in a later release — see `kanban/docs/05-private-kanban-spec.md`.

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
