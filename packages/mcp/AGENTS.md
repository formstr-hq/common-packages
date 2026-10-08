# Formstr MCP — Agent Guide

You are connected to `@formstr/mcp`, a Model Context Protocol server that gives you tools to
manage a person's **Formstr** account: forms, calendar, pages, drive, polls, and Mailstr email.
Everything is stored on Nostr relays under the user's own identity. There is no backend you can
query for help — **this document is the contract**.

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

Gated (`confirm: true` required) — 27 of 60 tools:
`update_form`, `share_form`, `delete_form`, `submit_form_response`,
`delete_calendar_event`, `update_calendar_event`, `attach_form_to_event`, `update_calendar`,
`delete_calendar`, `add_event_to_calendar`, `remove_event_from_calendar`, `approve_booking`,
`decline_booking`, `rsvp_event`, `delete_page`, `update_page`, `share_page`, `add_page_comment`,
`delete_poll`, `clear_my_vote`, `submit_poll_response`, `delete_file`, `rename_file`, `move_file`,
`send_mail`, `claim_mailbox`, `publish_mail_setup`.

The other 33 are always on. **"Always on" still means it publishes to the user's identity** —
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

---

## Errors and edge cases

- **`"Confirmation required…"`** — expected. Re-call with `confirm: true` after the user agrees.
- **`NOT_FOUND`** — the id/name doesn't exist. Re-run the relevant `list_*`; don't retry blindly.
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

This guide is the single entry point. Canonical source is the ngit repository; GitHub is a
read-only mirror.

- **Agent-readable (raw Markdown — what you want to feed a model):**
  `https://raw.githubusercontent.com/formstr-hq/common-packages/main/packages/mcp/AGENTS.md`
- **Human-readable (rendered):**
  `https://github.com/formstr-hq/common-packages/blob/main/packages/mcp/AGENTS.md`
- **Shipped in the package too:** `AGENTS.md` is included in the `@formstr/mcp` npm tarball, so
  `node_modules/@formstr/mcp/AGENTS.md` exists after any install.

For deeper operator detail — keystore internals, the full environment-variable and CLI-flag
reference, Ollama/Goose setup, troubleshooting — see [`README.md`](./README.md).

