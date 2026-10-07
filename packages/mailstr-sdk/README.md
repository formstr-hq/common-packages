# @formstr/mailstr-sdk

Headless TypeScript SDK for [Mailstr](https://mailstr.app) — Nostr-native
email. It covers the client side of the protocol end to end:

- **Identity** — derive a dedicated secp256k1 identity for mail (`createIdentity`),
- **NIP-98 auth** — sign `Authorization: Nostr …` headers for HTTP APIs
  (`signNip98`),
- **Mailbox claim** — buy a NIP-05 address like `you@mailstr.app` with a
  Lightning invoice you pay through your own wallet hook (`claimMailbox`),
- **Setup** — publish the kind-0 profile and kind-10050 DM-relay list that
  tell senders where to deliver (`publishSetup`),
- **Inbox** — read NIP-59 gift-wrapped mail (kind 1059 → kind 13 seal →
  kind 1301 mail rumor), verify it, and parse the RFC 2822 payload
  (`readInbox`, `unwrapMail`),
- **Send** — build the same rumor → seal → gift-wrap chain outbound, to a
  Nostr key or (via the domain's SMTP bridge) a legacy email address
  (`sendMail`).

Wire compatibility is pinned against the mailstr server (nail
`nostr-bridge`) protocol implementation — kinds, verification rules and the
§4 "byte string" content convention are ported verbatim.

## Install

```sh
pnpm add @formstr/mailstr-sdk
```

## Two identity models

Most functions take a raw 32-byte secret key — ideal when your app owns a
**dedicated mail identity** ([`createIdentity`](#identity-no-persistence--your-app-owns-storage)).
Hosts that never expose a private key (NIP-07 extensions, NIP-46 bunkers, the
MCP keystore) use the `…With` variants, which take a `MailSigner`:

```ts
import { readInboxWith, sendMailWith, type MailSigner } from "@formstr/mailstr-sdk";

// Any object with these four methods works — a @formstr/signer ActiveSigner,
// a @formstr/core NostrSigner, or your own wrapper. The private key never
// enters mailstr-sdk.
const signer: MailSigner = /* … */;
const inbox = await readInboxWith(signer, { relays: ["wss://relay.formstr.app"] });
await sendMailWith(signer, { to: "npub1…", subject: "Hi", text: "…" });
```

The identity behind the signer **is** the mail identity: mailstr's bridge
authorizes a sender by matching the seal's pubkey against the NIP-05 record for
the From address, so the account you sign with must be the account its
`name@domain` address is bound to.

### Aliases: one key, many addresses

A mail identity is one Nostr key; an **alias** is a NIP-05 name bound to that
key. An account can own several aliases (`you@mailstr.app`, plus
`you@yourdomain.com` on a managed workspace) — all sharing that one key and one
inbox, since mail is encrypted to the key and which alias it was addressed to is
only a header. When sending, `from` selects which alias appears in the `From:`.

```ts
import { fetchOwnedAddressesWith, defaultFromAddress, sendMailWith } from "@formstr/mailstr-sdk";

const aliases = await fetchOwnedAddressesWith(signer); // ["irona@mailstr.app", …]
const from = defaultFromAddress(await signer.getPublicKey(), aliases);
await sendMailWith(signer, { to: "npub1…", from, subject: "Hi", text: "…" });
```

`defaultFromAddress` prefers an owned registered alias over the npub mailbox,
because the bridge (external email) only accepts a registered alias while an
alias also works for Nostr-native recipients.

## Usage

### Identity (no persistence — your app owns storage)

```ts
import { createIdentity, identityFromSecretKey } from "@formstr/mailstr-sdk";

const identity = createIdentity();
// Persist identity.secretKeyHex somewhere safe (e.g. 0600 file, keychain).
// Never log it. Restore later with:
const same = identityFromSecretKey(identity.secretKeyHex);
```

### NIP-98 HTTP auth

```ts
import { signNip98 } from "@formstr/mailstr-sdk";

const auth = await signNip98(identity.secretKey, url, "POST", JSON.stringify(body));
const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: auth },
  body: JSON.stringify(body), // must match the string passed to signNip98
});
```

### Claim a NIP-05 mailbox

The SDK never holds wallets or mnemonics — you supply a payment hook:

```ts
import { claimMailbox } from "@formstr/mailstr-sdk";

const outcome = await claimMailbox(identity.secretKey, {
  name: "irona",
  tier: "base",
  payInvoice: async (invoice, amountSats) => {
    // Pay the bolt11 invoice with any Lightning wallet (NWC, Spark, …).
    await myWallet.payLightningInvoice({ invoice });
  },
});
// outcome.status: "claimed" | "paid-binding-pending"
//   | "payment-sent-binding-unverified" | "name-taken"
//   | "invoice-request-failed" | "invoice-shape-unexpected" | "payment-failed"
```

The claim flow: availability check → NIP-98-signed invoice request →
`payInvoice` hook → payment WebSocket watch → NIP-05 polling until
`name@domain` binds to your pubkey. Configure `timeoutMs`, `wsTimeoutMs` and
`pollIntervalMs` for CI-like environments; inject `fetchJson`/`WebSocket` in
tests.

### Publish setup events (profile + DM relays)

```ts
import { publishSetup } from "@formstr/mailstr-sdk";

await publishSetup(identity.secretKey, {
  name: "irona",
  nip05: "irona@mailstr.app",
  about: "Irona — self-sovereign mail agent.",
  // relays: ["wss://relay.formstr.app", "wss://relay.primal.net", "wss://nos.lol"],
});
```

Publishes kind 0 (profile with the `nip05` field) and kind 10050
(`["relay", <url>]` tags, empty content). Both are reported per relay —
relays that reject (auth, rate limits) show up in `results` as
`{ ok: false, detail }`.

### Read the inbox

```ts
import { readInbox } from "@formstr/mailstr-sdk";

const { mail, failures } = await readInbox(identity.secretKey, {
  relays: ["wss://relay.formstr.app"], // default: bootstrap relay set
  // pass acceptKinds: [1301, 14] to also surface NIP-17 DMs
});
for (const m of mail) {
  console.log(m.from, "|", m.subject, "|", m.text);
}
```

Each `mail` entry carries `wrapId`, the verified `seal` and `rumor`, the
decoded `raw` RFC 2822 content and the postal-mime fields
(`from`, `to`, `subject`, `messageId`, `text`). Wraps that fail verification
are reported in `failures` with a reason — they never abort the pass.

Single-wrap use:

```ts
import { unwrapMail } from "@formstr/mailstr-sdk";

const result = unwrapMail(wrapEvent, identity.secretKey);
```

Failure reasons: `not-for-us` (routine — the wrap was encrypted to someone
else), `malformed-seal`, `bad-seal-signature`, `wrong-seal-kind`,
`malformed-rumor`, `author-mismatch`, `wrong-rumor-kind`, `expired`,
`wrapkey-mismatch`.

### Send mail

Outbound mail mirrors `unwrapMail` in reverse — a kind-1301 rumor is sealed
(kind 13) and gift-wrapped (kind 1059) to the recipient's key:

```ts
import { sendMail } from "@formstr/mailstr-sdk";

// To a Nostr key (mailstr mailbox), by npub or hex:
await sendMail(identity.secretKey, {
  to: "npub1…",
  subject: "Hi",
  text: "Sent from the SDK.",
});

// To a legacy email address — routed through the domain's SMTP bridge,
// which is discovered from the `_smtp@<domain>` NIP-05 record:
await sendMail(identity.secretKey, {
  to: "friend@outside.example",
  subject: "Hi",
  text: "…",
  // bridge: { pubkey, relays },  // or pass an explicit BridgeIdentity
});
```

`to` accepts a hex pubkey, an `npub1…`, or an email address. Mailstr-local
addresses (`name@mailstr.app`) must be addressed by key — the bridge refuses
to relay to its own domains (`outbound.ts` §6B). Pass a fully-formed message
with `raw` instead of `subject`/`text`, and inject `pool` to control transport
(tests). Each call returns the published `wrap`, the resolved `recipient` key,
and per-relay `results`.

## Protocol notes

| Kind | Purpose |
| --- | --- |
| 1059 | NIP-59 gift wrap (`p` recipient, `k` inner kind) |
| 13 | NIP-59 seal (signed rumor, encrypted to recipient) |
| 1301 | Mail rumor: RFC 2822 message in `content` |
| 27235 | NIP-98 HTTP auth event |
| 0 / 10050 | Profile / NIP-17 DM relay list (setup) |

- **Byte string content (§4):** `rumor.content` carries one RFC 2822 octet
  per UTF-16 code unit. Use `bytesToMessageString`/`messageStringToBytes`
  when moving raw bytes in or out; postal-mime receives the original octets
  so ISO-8859-1 and friends decode correctly.
- **Unwrap verification:** the exact rule set (and failure vocabulary) of
  the mailstr server's `unwrapAndVerify`, including the author-mismatch
  spoof check that nostr-tools' own `unwrapEvent` lacks, and the
  `wrapkey` deletion-capability check.
- **Rumor staleness:** defaults to the server constant (300 seconds);
  override with `maxAgeSeconds`/`now` for inbox archaeology. NIP-59's
  randomized 2-day outer timestamp window is unrelated.
- **`WRAP_KEY_TAG` ("wrapkey")**: when present, `unwrapMail` validates it
  against the actual wrap author and returns it — the key lets you author a
  NIP-09 deletion request for that wrap.

## Development

```sh
pnpm install
pnpm build        # tsup → dist/ (ESM + CJS + d.ts)
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm test:coverage
```

Tests use synthetic throwaway keys only and inject every network surface
(HTTP, WebSocket, relay pool) — the suite never touches relays or secrets.

## License

MIT