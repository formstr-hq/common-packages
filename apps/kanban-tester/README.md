# kanban-tester

A browser host for `@formstr/kanban-sdk`, built to be demoed. Everything it shows is a real Nostr
event on real public relays — there is no mock runtime and no local relay.

```bash
cd apps/kanban-tester
pnpm install     # once, from anywhere in the workspace
pnpm dev         # http://localhost:5175
```

Vite aliases `@formstr/kanban-sdk` and `@formstr/signer` to their `src/`, so edits to either package
are live with no rebuild.

## What it exercises

| SDK surface | Where |
|---|---|
| `createBoard` (public 30301 and private 32301) | New board dialog, **Private board** toggle |
| `fetchBoards`, `fetchPrivateBoards` | Boards page — three groups: authored, maintained, private |
| `createCard`, `updateCard`, `deleteCard`, `moveCard` | Board columns; drag a card to move it |
| `createComment`, `fetchComments` | Card dialog, one level of replies |
| `invite`, `fetchMembers`, `removeMember`, `rotateBoardKey` | Members panel |
| `fetchInvitations`, `acceptInvitation`, `dismissInvitation` | Invitations inbox on the boards page |
| `NostrRuntime` | Event log drawer — decorates `SimplePoolRuntime`, no SDK change |

## The demo script

Two browser profiles, so there are two identities. Profile A is the owner, profile B the invitee.

1. **A:** log in — *New key* mints a throwaway NIP-49 identity. Copy nothing; it persists.
2. **A:** New board → keep **Private** checked → create. Watch the event log: a `32301` goes out with
   an opaque `content` and a random `d`, then a `32303` board list carrying the view key.
3. **A:** add two cards, drag one to *Doing*. Each move republishes the whole `32302`; the log shows
   ciphertext changing.
4. **A:** open a card → comment. That is a `32304`, also encrypted.
5. **B:** log in as a second identity in the other profile. Copy its npub from the header.
6. **A:** Members → paste B's npub → role *member* → send. The log shows a `1053` gift wrap.
7. **B:** Invitations → **Check inbox** → Accept. B lands on the board and reads every card — the
   view key arrived sealed, and B's client never asked A for anything.
8. **B:** try to add a card. Refused: members can read and comment, maintainers can write.
9. **A:** Members → Remove B → **Rotate key**. Every card and comment is re-encrypted under a fresh
   key and the remaining members are re-invited.
10. **B:** Refresh. B still holds the old key, so new writes are unreadable — B's board stops
    updating. What B already read, B keeps. Rotation cuts off the future, not the past.

For the public-board half: create a board with **Private** unchecked, then open
[kanbanstr.com](https://kanbanstr.com), point it at one of the same relays, and find the board in its
All Boards list. Public boards are byte-compatible with NIP-100, so it renders there unmodified.

## Things it deliberately does not do

- **No live updates.** The SDK facade exposes no subscription API, so every read here is explicit:
  after a write, on window focus, or via a Refresh button. Nothing on screen pretends to be live.
- **No delivery guarantee.** `publish` is timeout-bounded and resolves whether or not a relay stored
  the event. The UI says "publishing", then refetches — a card that does not come back did not land.
- **No StrictMode.** Its double-invoked effects fire every query twice, which would make the event
  log lie about how much traffic the SDK generates.

## Privacy, stated plainly

Private board *contents* are nip44-encrypted and relays see only ciphertext. But this runs on public
relays, so the following are visible to anyone: that a board exists, roughly how many cards it has,
when it changed, and — because invitations use kind `1053` rather than `1059` — who was invited to
it. That last one is `kanban/docs/07-gaps-risks.md` §A6, and it is a known open issue, not a bug in
this app.
