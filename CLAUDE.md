# CLAUDE.md — kanban-sdk

`@formstr/kanban-sdk` in `packages/kanban-sdk`: headless TypeScript SDK for Nostr Kanban boards.
Public boards are byte-compatible with kanbanstr.com; private boards add a NIP-100E encryption layer.

## Where things are

- **Code lives here** (`common-packages-kanban`), NOT in the sibling `common-packages` clone. Plan 1's text said otherwise and cost a session's confusion — trust this file.
- **Spec and plans live in `../kanban/docs/`.** Code comments cite them by section (`doc 05 §7`, `doc 07 §B2`); read the cited section before changing the behaviour it explains.
  - `05-private-kanban-spec.md` — the protocol (view keys, blinded pointer, access control, rotation)
  - `07-gaps-risks.md` — every known limitation, and which are decided vs open
  - `docs/plans/` — one plan per shipped increment
- `../calendar-sdk` (in `common-packages`) is the template SDK. `crypto/`, `discovery/`, `runtime/` here are deliberate copies of it, not shared code (doc 07 §D1 tracks extraction).

## Commands

Run everything from `packages/kanban-sdk/` — pnpm from the repo root fails with `Command "vitest" not found`.

- `pnpm vitest run` — full suite; `pnpm vitest run src/path/x.test.ts` for one file
- `pnpm typecheck` — `tsc --noEmit`, strict mode
- `pnpm build` — tsup, emits ESM + CJS + d.ts

Bash cwd persists between calls but is easy to lose — prefer absolute paths in `cd`.

## Status

Plans 1–3 are shipped and committed on branch `kanban-sdk` (unpushed). 265 tests green.

| Plan | Scope | State |
|---|---|---|
| 01 | Public NIP-100 boards/cards (30301/30302) | shipped |
| 02 | Private boards, cards, board lists (32301/32302/32303) | shipped |
| 03 | Invitations, members, comments (32304), `rotateBoardKey` | shipped |

Known-open, all documented and none blocking: reactions/zaps on private cards (doc 07 §C1);
board/card writes are not NIP-65 outbox-routed (only invitations are); no cryptographic read-only
role (§B3); attachments unencrypted (§C2); four one-line fixes noted at the end of the Plan 2 and 3
"Deliberately not solved" sections.

## Conventions

- `src/codec/` is **pure and synchronous** — no network, no `ctx`, no `Date.now()` in parsers. Services own all I/O; every byte of network goes through `NostrRuntime`.
- On private objects, `rawTags` holds the **decrypted inner tags**, not the event's outer tags. Edits merge into it via `mergeTags` — never rebuild from the model, or tags written by other clients vanish.
- Comments explain *why* and cite the spec section or the bug a rule prevents. Match that density; don't add narration.
- Private board events carry exactly `[["d",…]]`; private cards and comments exactly `[["d",…],["b",…]]`. Never an `alt` tag on anything private.
- Card and comment decryption must not touch the signer — the view key is local, so reading N cards costs zero signer round trips (doc 07 §D3).
- Every addressable republish uses `nextCreatedAt(previous)`.

## Gotchas that have bitten

- **`created_at` is seconds.** Two writes in one test tie, and NIP-01 breaks ties by lowest event id — which can keep the *stale* version. Tests asserting "newest wins" need explicitly different timestamps, not two calls in a row.
- **`FakeRuntime.seed()` overwrites unconditionally; `publish()` applies NIP-01 replacement.** Both key addressable kinds (30000–40000) by `kind:pubkey:d`, so you cannot seed two versions of one coordinate — a multi-version test needs two different authors.
- **`makeCtx` in `test/helpers.ts` must carry every new `KanbanCtx` field.** A missing one (e.g. `wrapKind`) surfaces as empty query results with no error, not as a type error, because the helper casts.
- **Verify heredoc/`python3` patches landed.** A non-matching replacement string silently no-ops; three edits appeared to succeed and hadn't, and the failure surfaced much later as a confusing test failure. Prefer the Edit tool, and `grep` after scripted edits.
- **Plan checkboxes are not state.** Plans ship with `- [ ]` boxes that execution does not tick. Use `git log` to find what is actually built.
