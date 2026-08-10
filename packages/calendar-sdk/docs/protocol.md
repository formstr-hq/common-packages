# The Formstr calendar protocol, as actually implemented

**Ground truth:** [`formstr-hq/nostr-calendar`](https://github.com/formstr-hq/nostr-calendar)
at `3dc32b1` (tag `v2.1.0`), read from source — `src/nostr/*.ts`, `src/utils/parser.ts`,
`src/utils/calendarListTypes.ts`, `src/stores/*.ts`. Not from its README, and not from any
generated protocol summary.

Everything below is what `calendar.formstr.app` puts on the wire today. This SDK's job is to
produce and consume exactly these bytes. Where the two could differ, upstream wins — a
one-sided "improvement" is a compatibility break wearing a nicer name.

Each section cites the upstream function it mirrors. When upstream moves, diff against the
pinned SHA and update this file first, the codecs second.

---

## 1. Kind registry

Mirrors `src/nostr/kinds.ts` (`EventKinds`).

| Kind | Name | Spec | Role |
|---|---|---|---|
| `0` | User profile | NIP-01 | read-only, sender display names |
| `5` | Deletion | NIP-09 | shared across all flows |
| `13` | Seal | NIP-59 | inner layer of every gift wrap |
| `14` | Rumor | NIP-17 | invitation payload; reads as a real DM in any NIP-17 client |
| `1059` | Gift wrap (outer) | NIP-59 | every wrap this protocol writes; typed by a `k` tag |
| `1052` | Invitation `k` discriminator | custom | tag value on the wrap, never a wire kind |
| `10002` | Relay list | NIP-65 | outbox/inbox routing |
| `30168` / `1069` | Form template / response | NIP-101 (Formstr) | attached forms |
| `31923` | Public calendar event | NIP-52 kind, simplified tags | |
| `31925` | Public RSVP | NIP-52 | |
| `31926` | Public busy list | custom | one per `(user, YYYY-MM)` |
| `32069` | Private RSVP | custom | |
| `32123` | Private calendar list | custom | self-encrypted |
| `32678` | Private calendar event | custom | view-key encrypted |

**In scope for this SDK:** everything above except the peripherals.

**Deliberately out of scope** (upstream has them; they are not calendar-protocol core):
scheduling pages `31927`, scheduling-page key sidecar `32680`, booking request/response wraps
(`1059` with `k=1057` / `k=1058`) and their legacy `1057`/`1058` forms, settings `30078`,
reports `1984`, NIP-05. The booking flow reuses the private-event and gift-wrap primitives
specified here, so adding it later is a service module, not a protocol change.

`31922` (NIP-52 date-only event) is **never used** — all-day and timed events are both `31923`.
There is no `32679` "private recurring" kind; recurrence lives in tag rows on `32678`.

---

## 2. Three encryption idioms, never interchangeable

From `src/nostr/crypto.ts`. Mixing these up is the single easiest way to produce events the
other client cannot read.

**(a) View-key self-encryption.** The caller holds raw secret key bytes it generated itself —
no signer, no login. NIP-44 encrypt to a conversation key derived from that key and *its own*
public key.

```ts
selfEncrypt(sk, data) = nip44.encrypt(JSON.stringify(data), getConversationKey(sk, getPublicKey(sk)))
```

Used by: private calendar events, private RSVPs. Anyone holding the key can read; the key
travels in invitations and calendar-list refs.

**Key encoding differs by domain and must not be normalized.** Calendar events carry the view
key **nsec-encoded** (`nip19.nsecEncode`). (Scheduling pages, out of scope here, use raw hex —
noted so a future contributor does not "unify" them.)

**(b) Signer self-encryption.** Requires the live NIP-07 / nsec-session / NIP-46 signer.
`signer.nip44Encrypt(ownPubkey, JSON.stringify(data))`. Only the real identity can ever read it.

Used by: calendar lists (`32123`).

**(c) NIP-59 gift wrap.** Three layers — see §6.

Upstream serializes a **gate** around the first concurrent `nip44Decrypt` call
(`crypto.ts:65`): external signers (nos2x-fox, Amber) show a permission popup on the first
call and reject everything else while it is pending. The SDK's services must likewise never
fan out concurrent signer decrypts.

---

## 3. Shared primitives

From `src/nostr/core.ts`.

```ts
makeDTag(input)  = bytesToHex(sha256(utf8ToBytes(input))).substring(0, 30)   // 30 chars, not 64
nextCreatedAt(p) = Math.max(Math.floor(Date.now() / 1000), p + 1)
```

`nextCreatedAt` exists because NIP-01 breaks a `created_at` tie between two versions of an
addressable event by **lowest event id** — so an edit published in the same second as the
version it replaces can silently lose. Every addressable republish uses it.

**Signing recomputes the id.** `buildAndSign` stamps `id = getEventHash(unsigned)` after the
signer returns, because some signers compute the id differently than the wire format expects
(`core.ts:12-17`).

**Event references** (`src/utils/calendarListTypes.ts`) are 3-element arrays, and the
coordinate is the first element — not a tag name:

```
["<kind>:<authorPubkey>:<eventDTag>", "<relayUrl>", "<viewKeyNsec>"]
```

`relayUrl` is `""` when unknown. Inside a calendar list these are spread into `["a", ...ref]`.

---

## 4. Private calendar event — kind `32678`

Mirrors `preparePrivateCalendarEvent` / `publishPrivateCalendarEvent`
(`src/nostr/events.ts:100-285`).

**Identity.** Addressable. `d` = a persisted id if the event already has one, else
`makeDTag(\`${JSON.stringify(event)}-${Date.now()}\`)`. Coordinate `32678:<author>:<d>`.

**Outer tags: exactly `[["d", dTag]]`.** Nothing else — no `alt`, no `p`, no `k`. Every other
field lives inside the ciphertext. An outer `p` row would leak the guest list.

**Content.** `selfEncrypt(viewSecretKey, innerTags)` where `viewSecretKey` is a **freshly
generated per-event keypair**, never the user's identity key. The inner payload is a JSON
array of tag rows, emitted in this order:

| Row | Notes |
|---|---|
| `["title", string]` | required |
| `["description", string]` | required |
| `["start", number]` | unix **seconds**, a JSON *number* — not a string |
| `["end", number]` | unix seconds, JSON number |
| `["image", string]` | **always emitted**, `""` when there is no image |
| `["d", dTag]` | repeated inside the payload — see below |
| `["L", "rrule"]`, `["l", <RRULE>]` | only when recurring, always as this pair |
| `["notification", "enabled"\|"disabled"]` | optional |
| `["form", naddr, viewKey?]` | repeats, one per attached form (§10) |
| `["location", string]` | repeats |
| `["p", authorPubkey]` | creator first, always |
| `["p", participantPubkey]` | one per invited participant |

The **inner `d` row is load-bearing**: upstream's `viewPrivateEvent` (`events.ts:511`) returns
`{...event, tags: decryptedTags}` — it *replaces* the outer tags — and the parser then reads
the event id from the `d` row. Omit it and every private event collapses under id `""` in
`calendar.formstr.app`, so only one survives.

**created_at.** `nextCreatedAt(previousCreatedAtSecs)`. On edit, upstream only trusts a
second-scale previous timestamp (`events.ts:301`): `ICalendarEvent.createdAt` is seconds when
parsed off a relay but milliseconds for a locally-built draft, so values `>= 1e12` are ignored.

**Edits.** Re-run the same builder with the **same `d` and the same view key**. Rotating the
key on edit strands every holder of the old one.

**Invitations on create.** Wraps go to `event.participants` only —
`targetPubKeys = Array.from(new Set([...event.participants]))` (`events.ts:214`). The creator
is **not** included, despite the comment two lines above claiming otherwise, and
`uniqueParticipants` never injects them. Do not "fix" this: sending a self-wrap puts a bogus
pending invitation to your own event in your own inbox.

**Invitations on edit.** Only participants *not* in the previous participant list. Removed
participants get **no revocation** — there is no un-invite mechanism.

**Relay hint.** The first relay that accepts the event is captured and threaded into both the
invitation `a` tag and the calendar-list ref, so recipients know where to fetch from.

---

## 5. Public calendar event — kind `31923`

Mirrors `publishPublicCalendarEvent` (`src/nostr/events.ts:586-628`).

**Written narrow:**

| Row | Notes |
|---|---|
| `["title", string]` | required |
| `["d", string]` | persisted id, else a fresh UUID |
| `["start", string]` | unix seconds as a **decimal string** (unlike the private payload) |
| `["end", string]` | unix seconds as a string |
| `["image", string]` | only when non-empty |
| `["location", string]` | repeats, only when present |
| `["p", pubkey]` | repeats, no role/relation qualifier |

`content` is the plaintext description string — **not** JSON, not a `description` tag, not
encrypted. No recurrence rows, no `t` categories, no `start_tzid`/`end_tzid`, no `r` website
are ever written on a public event.

**No gift-wrap invitation is sent for a public event.** That mechanism is private-event-only.

**Read wide.** Upstream's reader `nostrEventToCalendar` (`src/utils/parser.ts:18-120`) is far
more permissive than its writer, and accepts rows other clients emit:

- `title` **or** `name` for the title
- a `description` tag (overriding `content`)
- `r` → references, `t` → categories, `g` → geohashes
- `location` and `p`, repeated
- `image`, `notification`
- `form` with the view key at the **same row's third element**
- `["L","rrule"]` followed by `["l", <RRULE>]` — the reader takes `tags[index + 1][1]`,
  i.e. strictly the row *after* the label

So: **publish exactly the narrow set, parse the wide set.** A parser that only handles what
this SDK writes will drop data written by the standalone app.

`allDay` is derived, not stored (`isAllDayEvent(begin, end)`).

---

## 6. Invitations — NIP-59 gift wrap

Mirrors `wrapEvent`/`wrapEventAs`/`unwrapEvent` (`src/nostr/crypto.ts:118-240`) and the
invitation construction in `events.ts:231-259`.

### Layers

1. **Rumor** — unsigned, kind **`14`**. NIP-17's chat-message kind, reused deliberately so the
   invitation renders as a real DM in any NIP-17 client. Carries the sender's real `pubkey`
   and its true `created_at`.
2. **Seal** — kind `13`, content = `signer.nip44Encrypt(recipient, JSON.stringify(rumor))`,
   signed by the sender. No tags.
3. **Wrap** — kind **`1059`**, content = NIP-44 encrypted to the recipient under a **fresh
   ephemeral key per wrap**, signed by that key.

Wrap tags:

```
["p", recipientPubkey]      // mandatory, first
...callerExtraTags          // e.g. ["booking","true"]
["k", "1052"]               // type discriminator, always last
```

Both the seal and the wrap use real `created_at` values (`now()`), not jittered ones, matching
upstream byte for byte.

### Why `1059` + `k`

NIP-59 asks relays to serve a wrap only to its `p`-tagged recipient — a rule written for kind
`1059` **by number**. A private wrap kind gets none of that protection. But once every app's
wraps share one kind, an unfiltered inbox query returns DMs and other apps' traffic, each
costing a signer round trip to decrypt and discard. `k` is a single-letter tag, so relays can
filter on it: the inbox query is both protected and narrow.

### Invitation rumor

`content` is a human-readable sentence, so NIP-17 clients show something meaningful:

```
{senderName} has invited you to an event: {title}. View more details and add it to your
calendar here: {url}
```

where `senderName` is the profile's `display_name` or `name`, falling back to
`nip19.npubEncode(pubkey).slice(0, 12)`, and `url` is

```
{APP_BASE_URL}/event/{naddr}?viewKey={uriEncoded nsec}
```

with the `naddr` encoding `{kind, pubkey, identifier: dTag}` plus the relay hint (or the host's
configured relays when there is none). A host that configured no `appBaseUrl` gets the sentence
without the link.

Rumor tags:

```
["p", participantPubkey]
["a", "32678:<authorPubkey>:<dTag>", relayHint]
["viewKey", <nsec-encoded event view key>]
["signing_nsec", <nsec of the wrap's ephemeral key>]
```

`signing_nsec` is what makes recipient-side dismissal possible (§6.2). It is only reachable
after decryption, so it never leaks. It is absent on invitations sent before that change —
readers must treat it as optional.

### 6.1 Inbox query

One filter — the SDK reads exactly the wrap kind it writes:

```jsonc
{ "kinds": [1059], "#p": [me], "#k": ["1052"] }
```

Unwrapping failures are logged and skipped, never fatal: an inbox legitimately contains wraps
addressed to other apps.

### 6.2 Dismissal

A recipient cannot delete a wrap with their own signature — NIP-09 honours a deletion only
from the target event's author, and that author is a throwaway key. So the sender embeds that
key's nsec in the (encrypted) rumor, and the recipient self-signs:

```
kind 5, signed by the ephemeral key, tags: [["e", wrapId]]
```

Upstream's `buildSelfSignedDeletion` (`crypto.ts:250`) writes **`e` rows only**. This SDK adds
`["k", "1059"]`: NIP-09 says a deletion MUST carry `k`, upstream never *reads* deletion events
so this cannot desync the two clients, and a relay that enforces the rule would otherwise
reject the request and leave dismissal silently broken. Same class of read-compatible
deviation as the busy-list timestamp in §9.

**Alongside it, always**, a signer-authored kind 5 naming both `["e", wrapId]` and
`["a", coordinate]`, with `["k", "1059"]`. A strict relay will not honour it against a wrap it
did not author, but NIP-09 enforcement is optional and uneven: on a non-conformant relay this
is the durable tombstone the inbox reads back, which is what keeps a dismissal holding across
devices. Wraps with no `signing_nsec` get this one only.

### 6.3 Verification (SDK-side hardening)

Upstream's `unwrapEvent` decrypts both layers and returns the rumor without checking it. The
rumor is **unsigned**, so its `pubkey` field is an unverified claim. This SDK additionally
requires, and throws otherwise:

- the seal is kind `13`;
- `verifyEvent(seal)` passes;
- `rumor.pubkey === seal.pubkey`.

This is strictly a read-side check — it changes no bytes and cannot desync the two clients.
Without it, a wrap can be forged to appear to come from any pubkey, and an invitation is a
capability: it hands over the view key.

---

## 7. Private calendar list — kind `32123`

Mirrors `src/nostr/calendars.ts`.

**Outer tags:** `[["d", calendarId]]`. `calendarId = makeDTag(\`${JSON.stringify(data)}-${Date.now()}\`)`.

**Content:** signer-self-encrypted (idiom (b)) JSON array of tag rows:

```
["title", string]
["content", description]              // note: "content", not "description"
["color", "#4285f4"]
["notifications", "disabled"]         // ONLY when disabled — "enabled" is never written
["a", "<kind>:<author>:<dTag>", relayUrl, viewKeyNsec]   // repeats, one per event
```

The reader stores each `a` row as `[tag[1], tag[2], tag[3]]` — the ref triple of §3.

`created_at` uses `nextCreatedAt(list.createdAt)`.

Upstream guards the subscription stream against wrong-kind deliveries (`calendars.ts:183`):
relays occasionally return e.g. a `31926` busy list, whose empty content cannot parse as a
tags array. Skip, don't throw.

**Membership is resolved from list refs, not from the event.** `findCalendarForEvent` scans
every list's refs for the coordinate. The view key for an event you authored is recoverable
from the ref, which is why an edit must never mint a fresh key without also updating the ref.

---

## 8. RSVPs

Mirrors `src/nostr/rsvp.ts`.

Shared d-tag, deterministic so one replaceable event holds the latest status per responder:

```ts
rsvpDTag = makeDTag(`${responderPubkey}:${authorPubkey}:${eventDTag}`)
```

Payload shape: `{ status, suggestedStart?, suggestedEnd?, comment? }` where status is
`accepted` | `declined` | `tentative`. (`pending` exists in the UI enum but is never written.)
`suggestedStart`/`suggestedEnd` are unix **seconds**.

**Private RSVP — kind `32069`:**

```
tags:    ["a", "<32678>:<author>:<eventDTag>", relayHint?]   // relayHint omitted, not ""
         ["d", rsvpDTag]
content: selfEncrypt(eventViewKey, payload)
```

Encrypted under the *event's* view key, so exactly the set of people who can read the event
can read the RSVPs. `created_at` is a plain `now` — upstream does **not** use `nextCreatedAt`
here.

**Public RSVP — kind `31925`:**

```
tags:    ["a", coordinate, relayHint?]
         ["status", status]
         ["start", "<sec>"]?     // only when a suggestion was made
         ["end", "<sec>"]?
         ["d", rsvpDTag]
content: comment
```

Note the asymmetry: the private variant carries the comment *inside* the ciphertext, the
public one in `content`.

Queries are by `"#a": [coordinate]`. A record whose decoded `eventCoord` does not match the
requested coordinate is dropped (`rsvp.ts:266`) — the `#a` filter is not trusted alone.

There is **no** RSVP gift-wrap path. Any kind `1055`/`55` handling is a fiction from an
earlier lineage and must not appear in this SDK.

---

## 9. Public busy list — kind `31926`

Mirrors `src/nostr/busy.ts` + `busyListToTags` / `nostrEventToBusyList`
(`src/utils/parser.ts:307-384`).

One addressable event per `(user, month)`; the month **is** the d-tag.

```
tags:    ["d", "YYYY-MM"]
         ["t", "YYYY-MM"]      // queryable hashtag
         ["t", "busy"]
         ["block", "<startSec>", "<endSec>"]   // repeats
content: ""                     // intentionally empty — no titles or descriptions leak
```

The d-tag must match `/^\d{4}-\d{2}$/`; anything else parses to `null`. Ranges are stored in
milliseconds in memory, seconds on the wire; on read they are sorted by `(start, end)` and
deduped on exact equality, and any range with `end <= start` or a non-finite bound is dropped.

`created_at` is a plain `now` upstream. This SDK uses `nextCreatedAt` here — a same-second
republish that loses the tie drops a busy block, which means a double-booking. That is a
read-compatible change: the bytes are identical, only the timestamp is nudged.

---

## 10. Form attachments (Formstr / NIP-101)

Row shape, identical on private events and (out-of-scope) scheduling pages:

```
["form", <naddr>, <formViewKey>?]
```

The optional third element is the form's **read-only** NIP-44 decryption key — the same value
Formstr surfaces as `?viewKey=<hex>` or inside an `#nkeys1…` blob.

**It must never be the form's `responseKey`** (a.k.a. admin/edit key). That key grants write
access to the form definition; embedding it in a calendar event would hand every recipient the
ability to rewrite the form. Upstream states this twice, in `events.ts:126` and
`utils/types.ts:37`, because it is the kind of mistake that is invisible until it is exploited.

Reading a response: kind `1069` filtered by `"#a": ["30168:<formPubkey>:<dTag>"]`, optionally
narrowed by `authors`.

---

## 11. Deletions and relay routing

**Deletion — kind `5`** (`publishDeletionEvent`, `events.ts:633`):

```
tags:    ["e", eventId]      // repeats
         ["a", coordinate]   // repeats
         ["k", "<kind>"]     // repeats, one per kind involved
content: reason ?? ""
```

An addressable event is deleted by coordinate; a wrap by id.

**Relay list — kind `10002`** (NIP-65): `["r", url]` rows.

Before publishing anything `p`-tagged, fetch the recipients' relay lists so delivery routes to
their inboxes rather than only the author's relays (`events.ts:215-218`). Upstream's worker
routes to `user relays ∪ author outbox ∪ p-tagged recipients' inbox`; a plain-pool runtime has
to do that union itself.

**Replaceable resolution.** Per NIP-01, for two versions of one coordinate the higher
`created_at` wins; on a tie the **lower event id** wins. Every fetch path resolves duplicates
this way rather than taking the last one delivered.

---

## 12. Deliberate parity — behaviours that look like bugs and stay

Each of these is a place where fixing one side alone makes the two clients disagree. They are
enforced by tests so a future contributor has to argue with a failing assertion rather than a
comment.

1. **The creator receives no invitation wrap** for their own event.
2. **Removed participants receive no revocation.** There is no un-invite.
3. **Public events never carry recurrence**, categories, or tzid rows, even though the reader
   accepts them.
4. **Private RSVPs use a plain `now`**, not `nextCreatedAt`.
5. **Recurrence expansion is UTC-only** and ignores `start_tzid`. Upstream has the same
   limitation; a tzid-aware expansion here would compute different occurrence times than the
   app showing the same event.
6. **`["notifications", "enabled"]` is never written** to a calendar list — absence means
   enabled.
7. **The view key encoding differs by domain** (nsec for events) and is not normalized.

---

## 13. Interop verification

Unit tests over this SDK's own codecs prove nothing about interop — they are self-consistent
by construction. So `test/upstream-parsers.ts` carries upstream's **real** readers, ported
verbatim with a provenance header naming the source file, function, and SHA:

- `nostrEventToCalendar` (`src/utils/parser.ts`)
- `decryptCalendarList` (`src/nostr/calendars.ts`)
- `parsePrivateRSVPEvent` and `parseRSVPTags` (`src/nostr/rsvp.ts`)
- `nostrEventToBusyList` / `busyListToTags` (`src/utils/parser.ts`)
- the rumor-tag extraction from `getDetailsFromGiftWrap` (`src/nostr/events.ts`)

Every domain is asserted in **both** directions:

- *outbound* — an event this SDK publishes is fed to upstream's parser, and every field the
  app depends on comes back intact;
- *inbound* — an event built by upstream's own writer is fed to this SDK's parser.

Ported code is never edited to make a test pass. If upstream's parser rejects our output, our
output is wrong.
