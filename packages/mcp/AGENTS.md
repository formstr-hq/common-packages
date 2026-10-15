# Formstr MCP — Agent Guide

You are connected to `@formstr/mcp`, a Model Context Protocol server that gives you tools to
manage a person's **Formstr** account: forms, calendar, pages, drive, polls, Mailstr email, and
**kanban boards**. Everything is stored on Nostr relays under the user's own identity. There is no
backend you can query for help — **this document is the contract**.

Read the [Golden rules](#golden-rules) and the [confirm gate](#the-confirm-gate) before your
first write. Then jump to the module you need.

---

## Before you can do anything

You almost certainly cannot change this yourself — it is a one-time, human, out-of-band step.
But you should know what it is so you can tell the user exactly what's wrong if a tool is
missing or a command fails.

**1. A human signs in once** (interactive terminal; never in the chat):

```bash
npx -y @formstr/mcp login
```

They pick **Bunker URI (NIP-46)** for the best setup — the private key stays in their signer
app (Amber, nsec.app), only a session is stored, and no passphrase is ever needed in a config
file. The alternative, an `ncryptsec` key, unlocks with a passphrase supplied via the
`FORMSTR_MCP_NCRYPTSEC_PASSPHRASE` env var in the host config. Either way **the key never
reaches you**.

**2. The host starts the server.** The user adds an entry to their MCP host config
(`claude_desktop_config.json`, Cursor's `~/.cursor/mcp.json`, Goose, …):

```json
{
  "mcpServers": {
    "formstr": {
      "command": "npx",
      "args": ["-y", "@formstr/mcp", "--allow-writes"]
    }
  }
}
```

- **`--allow-writes` is what registers the gated tools.** Without it, tools like `send_mail`,
  `delete_form`, `update_page`, `share_form` are **absent from your tool list entirely** — not
  disabled, just not there. If a write tool the user expects is missing, this is why: tell them
  to add the flag and restart the host.
- The flag does **not** make anything automatic — every gated tool still requires you to pass
  `confirm: true`, and you should only do that after the user agrees (see
  [the confirm gate](#the-confirm-gate)).
- Add `"--relays", "wss://a,wss://b"` to override the relay set if the user asks.

That's the whole setup. If the tools are present and `list_*` calls work, you're good — the
sections below are everything else.

---

## Golden rules

1. **Never invent an id.** Every tool that acts on existing data takes an id, pubkey, or
   `coordinate` returned by a *list/get* tool. Chain reads before writes: list → pick → act.
2. **A write tool needs `confirm: true`.** Without it the tool returns a "Confirmation
   required…" message and does nothing. See [the confirm gate](#the-confirm-gate).
3. **Creating is not gated, but it is real and public-permanent.** `create_*` tools are always
   on and publish immediately on the user's identity. Don't create things the user didn't ask
   for.
4. **Addresses and coordinates are exact strings.** Coordinates look like `kind:pubkey:d`.
   naddr/npub are bech32. Don't "fix" or reformat them.
5. **Report outcomes honestly.** Tools return `ok`/`errorCode`. Relay publishes return per-relay
   results; partial success is normal. Say what actually happened, don't claim success on a
   failed call.
6. **The user's key never reaches you.** No tool returns secrets. If you ever see key material
   in output, stop and tell the user — it's a bug.
7. **Prefer the smallest action.** Use list/get to confirm before update/delete. Never delete or
   overwrite without the user's explicit go-ahead in the conversation.

---

## The confirm gate

Roughly half the tools are marked **gated** (destructive, outward, or identity-changing). Each
is registered *and* requires `confirm: true` on the call.

### How to use it safely

The first call **without** `confirm` is a free preview: it returns exactly what would happen
and executes nothing.

```
send_mail({ to: "alice@example.com", subject: "Hi", text: "…" })
→ { ok: false, text: "Confirmation required for \"send_mail\". This action is irreversible
   and acts on your Nostr identity: sends email to \"alice@example.com\". Re-call with
   \"confirm\": true to proceed." }
```

The correct pattern is:

1. Call the gated tool **once without `confirm`** (or just describe the effect to the user).
2. Show the user what will happen and get their agreement **in the conversation**.
3. Call again with `confirm: true`.

Do **not** silently pass `confirm: true` on the first try for anything destructive. For
outward actions (send mail, share) or deletions, always surface the effect to the user first.

### What is gated

Gated (`confirm: true` required) — 33 of 72 tools:
`update_form`, `share_form`, `delete_form`, `submit_form_response`,
`delete_calendar_event`, `update_calendar_event`, `attach_form_to_event`, `update_calendar`,
`delete_calendar`, `add_event_to_calendar`, `remove_event_from_calendar`, `approve_booking`,
`decline_booking`, `rsvp_event`, `delete_page`, `update_page`, `share_page`, `add_page_comment`,
`delete_poll`, `clear_my_vote`, `submit_poll_response`, `delete_file`, `rename_file`, `move_file`,
`send_mail`, `claim_mailbox`, `publish_mail_setup`, `claim_kanban_card`, `update_kanban_card`,
`move_kanban_card`, `delete_kanban_card`, `delete_kanban_board`, `add_kanban_comment`.

The other 39 are always on. **"Always on" still means it publishes to the user's identity** —
`create_*`, `save_private_note`, `import_form_from_naddr`, and `submit_*` are real writes even
though they don't need `confirm`.

> If a gated tool is **absent** from your tool list entirely, the server was started without
> `--allow-writes`. Tell the user; you cannot enable it from here.

---

## Addresses, ids and coordinates

| Thing | Format | Example | Produced by |
| --- | --- | --- | --- |
| Form | `formId` + author `pubkey` | `a1b2…` / `c3d4…` | `list_forms`, `create_form` |
| Form reference | `naddr1…`, `pubkey:formId`, or `kind:pubkey:formId` | — | `create_form` (`naddr`) |
| Calendar event / calendar | `coordinate` = `kind:pubkey:d` | `31923:<pk>:my-event` | `list_calendar_events`, `create_calendar_event` |
| Calendar list | its `id` (d-tag) | `work` | `list_calendars`, `create_calendar` |
| Page / doc | `docId` (d-tag) + author `pubkey`, or an `address` | — | `list_pages`, `create_page` |
| Poll | `pollEventId` | `ab12…` | `list_polls`, `create_poll` |
| Drive file | `name` (+ optional `folder`) | `report.pdf` | `browse_files` |
| Kanban board | `coordinate` = `kind:pubkey:d` (`30301` public / `32301` private) | `30301:<pk>:<d>` | `list_kanban_boards`, `create_kanban_board` |
| Kanban card | its `id` (d-tag) + the board `coordinate` | `<d>` / `30301:<pk>:<d>` | `list_kanban_cards`, `create_kanban_card` |
| Mail message | `mailId` (the wrap id) | `ef56…` | `list_mail` |

**Private/encrypted things need a view key.** Forms, pages, and private calendar events can be
encrypted; pass `viewKey` (an `nsec`) where a tool offers it or you will get ciphertext or an
error. `list_shared_pages` returns the `viewKey` for documents shared with the user.
`get_calendar_event` reports `registrationFormHasViewKey` so you can check an attached form is
readable.

---

## Tool catalog

### Forms (9)

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_forms` | — | The user's forms index. Start here. |
| `get_form` | `pubkey`, `formId` | Pass `viewKey` for encrypted forms. |
| `fetch_form_responses` | `formAuthorPubkey`, `formId` | Submissions with responder + answers. |
| `create_form` | `name`, `fields` | Always on. Returns `formId`, `pubkey`, `naddr`. |
| `import_form_from_naddr` | `ref` | `naddr1…`, `pubkey:formId`, or `kind:pubkey:formId`. |
| `update_form` ⚠ | `formId`, `formPubkey` | Republish name/fields/description. Gated. |
| `share_form` ⚠ | `formId`, `formPubkey`, `recipients` | Gift-wraps the **view key**; `editors` also get edit access. Gated. |
| `delete_form` ⚠ | `formId`, `formPubkey` | NIP-09 deletion. Gated. |
| `submit_form_response` ⚠ | `formAuthorPubkey`, `formId`, `answers` | Submits on the user's identity. Gated. |

`create_form` fields: each is `{ type, label, required?, options?, validation?, … }`. Supported
types: `short`, `paragraph`, `choice`, `dropdown`, `number`, `date`, `time`, `grid`, `file`,
`signature`, `section`. Optional: `description`, `publicForm`, `encrypted`,
`allowedResponders`, `collaborators`, `notifyNpubs`, `titleImageUrl`, `coverImageUrl`,
`thankYouText`.

> **Encrypted form?** After `create_form` with `encrypted: true`, share it with
> `share_form` so the people you want can read it — otherwise only the creator can.

### Calendar (19)

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_calendar_events` | — | Optional ISO-8601 `since`/`until`. |
| `get_calendar_event` | `coordinate` | |
| `create_calendar_event` | `title`, `start` | **Defaults to PRIVATE.** See note below. |
| `list_calendars` | — | |
| `create_calendar` | `title` | A calendar *list* (like a folder). |
| `fetch_event_rsvps` | `coordinate` | |
| `list_invitations` | — | NIP-59 invitations received. |
| `list_scheduling_pages` | — | Booking links, each with a shareable URL. |
| `list_booking_requests` | — | Incoming appointment requests. |
| `approve_booking` ⚠ | `requestId`, `calendarId` | Creates the appointment, notifies booker. Gated. |
| `decline_booking` ⚠ | `requestId` | Gated. |
| `delete_calendar_event` ⚠ | `eventId` | Gated. |
| `rsvp_event` ⚠ | `eventCoordinate`, `status` | Gated. Optional suggested time/comment. |
| `update_calendar_event` ⚠ | `coordinate` | Only send changed fields. Gated. |
| `attach_form_to_event` ⚠ | `coordinate`, `formRef` | Gated. Pass `formViewKey` for encrypted forms. |
| `update_calendar` ⚠ | `id` | Gated. |
| `delete_calendar` ⚠ | `coordinate` | Gated. |
| `add_event_to_calendar` ⚠ | `calendarId`, `coordinate` | Gated. |
| `remove_event_from_calendar` ⚠ | `calendarId`, `coordinate` | Gated. |

> **`create_calendar_event` workflow (important).** Events are linked into a calendar list;
> that link is the only way they render on calendar.formstr.app. If you omit `calendarId` and
> the user already has calendars, the tool returns the list and a `CALENDAR_REQUIRED` code —
> **ask the user which calendar**, then re-run with `calendarId`. `isPrivate:false` makes a
> public unencrypted event, which does **not** sync to calendar.formstr.app. `participants`
> (npub/hex) receive NIP-59 invitations. To attach a registration form, pass
> `registrationFormRef` and, for encrypted forms, `registrationFormViewKey`.

### Pages (12)

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_pages` | — | |
| `get_page` | `pubkey`, `docId` | Pass `viewKey` if encrypted. |
| `list_shared_pages` | — | Docs shared with the user (carries `viewKey`). |
| `get_page_tags` | `address` | Private labels. |
| `list_page_comments` | `address`, `viewKey` | Inline comments/suggestions (kind 1494). |
| `create_page` | `title`, `content` | Markdown, encrypted. Always on. |
| `save_private_note` | `title`, `content` | Quick encrypted note. Always on. |
| `set_page_tags` | `address`, `tags` | Always on. |
| `update_page` ⚠ | `docId`, `content` | Replaces content. Gated. |
| `delete_page` ⚠ | `address` | NIP-09. Gated. |
| `share_page` ⚠ | `address`, `content` | Re-encrypts under a view key; `canEdit` for edit links. Gated. |
| `add_page_comment` ⚠ | `address`, `eventId`, `viewKey`, `content` | Gated. |

### Polls (8)

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_polls` | — | User's own polls. |
| `list_recent_polls` | — | Public polls to discover. Optional `limit`. |
| `get_poll` | `pollEventId` | Includes option ids. |
| `fetch_poll_results` | `pollEventId` | |
| `create_poll` | `question`, `options` | Always on. |
| `submit_poll_response` ⚠ | `pollEventId`, `optionIds` | Gated. |
| `delete_poll` ⚠ | `pollEventId` | Gated. |
| `clear_my_vote` ⚠ | `pollEventId` | Retract own votes. Gated. |

### Drive (5)

| Tool | Required args | Notes |
| --- | --- | --- |
| `browse_files` | — | Encrypted drive; optional `folder`. |
| `get_file_info` | `name` | Optional `folder`. |
| `delete_file` ⚠ | `name` | **Soft delete** — blob stays on Blossom, index forgets it. Gated. |
| `rename_file` ⚠ | `name`, `newName` | Gated. |
| `move_file` ⚠ | `name`, `newFolder` | Gated. |

> There is **no upload/create-file tool** — Blossom blobs can't stream over the MCP text
> channel. Upload happens in the web app; the MCP browses and manages metadata only.

### Mail — Mailstr (7)

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_mail` | — | A page of the inbox, newest first. Page with `until`. |
| `read_mail` | `mailId` | Full body of one message (fetched by id). |
| `who_is_my_mail_address` | — | Signed-in identity, default `From:`, and aliases. |
| `list_mail_aliases` | — | Every address the account can send as, and the default. |
| `send_mail` ⚠ | `to` | `to` = npub/hex **or** external email. Gated. |
| `claim_mailbox` ⚠ | `name` | Returns a **bolt11 invoice**; the server cannot pay it. Gated. |
| `publish_mail_setup` ⚠ | `name` | Profile (nip05) + kind-10050 delivery relays. Gated. |

**Aliases.** One identity owns many NIP-05 addresses (`you@mailstr.app`, or
`you@yourdomain.com` on a workspace), all sharing one inbox. Pass `from` to `send_mail` to
choose which alias appears in the `From:`; call `list_mail_aliases` first to see the options. A
`from` the account doesn't own is rejected with the valid list. `send_mail` needs `text` or
`raw`. For external email, the `From:` must be a registered alias (not the bare npub) or the
bridge bounces it.

**Paging a large inbox.** `list_mail` returns a bounded **page** (default 50, newest first) —
it does not scan the whole mailbox. When the page is full the result includes `oldestReceivedAt`
and `hasMore: true`; to read further back, call again with `until` set to that value. `since`
and `until` are unix seconds. If you only need one message you already have the id for, call
`read_mail` — it fetches that exact wrap and never depends on the page window.

> **Claiming is two-step and human-driven.** `claim_mailbox` returns a bolt11 invoice. The
> user pays it in their own wallet. Then the address starts working once NIP-05 propagates.
> You **cannot** complete payment from here.

### Kanban (12)

Boards are interoperable with [kanbanstr.com](https://kanbanstr.com). A board is a
replaceable event addressed by `coordinate` = `kind:pubkey:d` — public (`30301`) or encrypted
(`32301`). Cards live inside a board; each card's `status` names the column it sits in.

| Tool | Required args | Notes |
| --- | --- | --- |
| `list_kanban_boards` | — | Boards the user owns, administers, or holds a key for. **Start here.** |
| `list_kanban_cards` | `board` | All cards on one board (by coordinate). |
| `list_my_kanban_cards` | — | Cards assigned to the user across every board. |
| `list_kanban_inbox` | — | Assigned cards still in the first column — the **pick-up queue**. Optional `board` to scope it. |
| `create_kanban_board` | `title` | Always on. Optional `columns`, `description`, `private:true`. |
| `create_kanban_card` | `board`, `title` | Always on. Optional `status`, `description`, `assignees`, `labels`. |
| `claim_kanban_card` ⚠ | `board`, `cardId` | Move an **assigned** card out of the first column. Idempotent. Gated. |
| `update_kanban_card` ⚠ | `board`, `cardId` | Change title/description/assignees/labels. Gated. |
| `move_kanban_card` ⚠ | `board`, `cardId`, `status` | Move to a column. Gated. |
| `delete_kanban_card` ⚠ | `board`, `cardId` | Only the card's author may delete it. Gated. |
| `delete_kanban_board` ⚠ | `board` | Only the board owner. Gated. |
| `add_kanban_comment` ⚠ | `board`, `cardId`, `content` | **Private boards only** (see note). Gated. |

**Rules that matter.**

- **`board` is always a coordinate** (`30301:<pk>:<d>` or `32301:<pk>:<d>`) from a list tool.
  Never invent one. `create_kanban_board` returns the new one; the app route is `/kanban`.
- **Columns.** Default `To Do / In Progress / Done`. `status` accepts a column **name or id** and
  the tool maps it to the wire value (public boards use the column *name*, private boards the
  *id* — you never deal with that). Moving to an unknown column returns `BAD_INPUT` with the
  valid names.
- **Assignments drive everything.** `assignees` are hex pubkeys. A card assigned to someone (or
  to an agent) is how work is handed off; on a public board each assignee is tagged `["p", …]`,
  so a watcher can subscribe to `{ kinds:[30302], "#p":[agent] }` and see new work without
  knowing the boards.
- **The pick-up loop.** To do assigned work: `list_kanban_inbox` → for each card
  `claim_kanban_card` (takes it off `To Do`) → do the work → `move_kanban_card` to `Done`
  (and/or `update_kanban_card` the description). It is **idempotent**: claiming a card that
  already moved returns `claimed:false` and changes nothing, so a repeated or racing pick-up is
  safe.
- **Comments are private-board-only** right now — the bundled SDK's comment codec always uses
  the private kind and needs the board view key. On a public board, `add_kanban_comment` returns
  `BAD_INPUT`; use `update_kanban_card` (e.g. append to `description`) to report progress
  instead.
- **Private boards** are read through a board list that carries the view key; the list/card
  tools resolve it for you. Key material is never returned — never echo it if you ever see it.

---

## Recipes

### "Make me a survey and share it"

```
create_form { name: "Team offsite", fields: [
  { type: "short", label: "Your name", required: true },
  { type: "choice", label: "Preferred month", options: ["May","June","July"] },
  { type: "paragraph", label: "Dietary needs" }
], encrypted: true }
→ formId = F, pubkey = P

# encrypted forms must be shared to be readable:
share_form { formId: F, formPubkey: P, recipients: ["npub1…"], confirm: true }
→ tell the user it's shared and irreversible-ish
```

### "Schedule a meeting with X"

```
list_calendars          # does the user have a calendar list?
create_calendar_event { title: "Sync", start: "2026-10-20T15:00:00Z",
                        end: "2026-10-20T15:30:00Z", participants: ["npub1…"] }
# if it returns CALENDAR_REQUIRED → ask the user which calendar, then:
create_calendar_event { …, calendarId: "<chosen>" }
```

### "Send an email to alice@example.com as me"

```
list_mail_aliases        # see what From: addresses are available
send_mail { to: "alice@example.com", subject: "Hi", text: "…",
            from: "me@mailstr.app" }          # preview (no confirm)
# show the user, get agreement, then:
send_mail { to: "alice@example.com", subject: "Hi", text: "…",
            from: "me@mailstr.app", confirm: true }
```

### "What did I miss in my inbox?"

```
list_mail                # newest first
read_mail { mailId: "<id from list>" }
```

### "Give me a board and add a task"

```
create_kanban_board { title: "Launch", columns: ["To Do", "Doing", "Done"] }
→ board = <coordinate>

create_kanban_card { board: board, title: "Write the announcement",
                     status: "To Do", labels: ["docs"] }
# assign it to a person (hex pubkey) or to an agent:
create_kanban_card { board: board, title: "Review copy", assignees: ["<hex pubkey>"] }
```

### "What's assigned to me / pick up my work"

```
list_kanban_inbox                       # assigned cards still in "To Do"
# for each: take it, do the work, close it out
claim_kanban_card { board: "<coord>", cardId: "<id>", confirm: true }   # -> "In Progress"
move_kanban_card  { board: "<coord>", cardId: "<id>", status: "Done", confirm: true }
```

> An agent that watches for hand-offs polls `list_kanban_inbox` (optionally with a `board`
> scope), or subscribes to kind `30302` with `#p` = its own pubkey, then `claim_kanban_card`s
> whatever is assigned to it.

---

## Errors and edge cases

- **`"Confirmation required…"`** — expected. Re-call with `confirm: true` after the user agrees.
- **`NOT_FOUND`** — the id/name doesn't exist. Re-run the relevant `list_*`; don't retry blindly.
- **`NOT_ASSIGNED`** — `claim_kanban_card` was called on a card not assigned to you. Only pick
  up cards that name your pubkey in `assignees`.
- **`CALENDAR_REQUIRED`** — `create_calendar_event` needs a `calendarId`. The message lists the
  available calendars; ask the user, then re-run.
- **`BAD_INPUT`** — a parameter is missing, unknown, or invalid (this includes a `from` address
  the account doesn't own). The message names the valid values; fix and retry.
- **`CLAIM_FAILED`** — `claim_mailbox` couldn't create an invoice (name taken, or the API
  rejected the request). Read the message, don't retry blindly.
- **Unknown parameter error** — tool schemas are **strict**; an unrecognized key is rejected
  with `BAD_INPUT` rather than ignored. Use exactly the parameter names in this guide. (This is
  deliberate: before, a typo'd parameter was silently dropped and you'd think a write happened
  when it didn't.)
- **Partial relay success** — publish tools return per-relay results. Report how many relays
  accepted; a few failing is normal and not an error.
- **Gated tools missing** — the server runs without `--allow-writes`. You can't change it; tell
  the user.
- **Encrypted data looks like ciphertext** — you need the `viewKey`/`nsec`. Ask the user or list
  shared items.

---

## Pointing other agents here

This guide is the single entry point. Canonical source is the **ngit** (Nostr Git) repository;
GitHub is a read-only mirror. Browse it on [gitworkshop.dev](https://gitworkshop.dev):

- **Canonical repo — gitworkshop.dev:**
  `https://gitworkshop.dev/npub1cgd35mxmy37vhkfcmjckk9dylguz6q8l67cj6h9m45tj5rx569cql9kfex/relay.ngit.dev/common-packages`
- **This guide — gitworkshop.dev:**
  `https://gitworkshop.dev/npub1cgd35mxmy37vhkfcmjckk9dylguz6q8l67cj6h9m45tj5rx569cql9kfex/relay.ngit.dev/common-packages/tree/main/packages/mcp/AGENTS.md`
- **Clone with ngit (native git):**
  `git clone nostr://npub1cgd35mxmy37vhkfcmjckk9dylguz6q8l67cj6h9m45tj5rx569cql9kfex/relay.ngit.dev/common-packages`
- **Agent-readable (raw Markdown — what you want to feed a model):**
  `https://raw.githubusercontent.com/formstr-hq/common-packages/main/packages/mcp/AGENTS.md`
- **Shipped in the package too:** `AGENTS.md` is included in the `@formstr/mcp` npm tarball, so
  `node_modules/@formstr/mcp/AGENTS.md` exists after any install.

PRs and issues for this repo live on the same gitworkshop.dev page (Nostr Git) — not on the GitHub
mirror.

For deeper operator detail — keystore internals, the full environment-variable and CLI-flag
reference, Ollama/Goose setup, troubleshooting — see [`README.md`](./README.md).

