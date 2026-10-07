# Common Packages for formstr

Shared packages used across Formstr / Nostr ecosystem apps.

| Package | npm | What it is |
| --- | --- | --- |
| `@formstr/signer` | [![npm](https://img.shields.io/npm/v/@formstr/signer)](https://www.npmjs.com/package/@formstr/signer) | Nostr signer with login UI for NIP-07, NIP-46, NIP-49 and NIP-55. |
| `@formstr/local-relay` | [![npm](https://img.shields.io/npm/v/@formstr/local-relay)](https://www.npmjs.com/package/@formstr/local-relay) | A local Nostr relay for development and tests. |
| `@formstr/calendar-sdk` | [![npm](https://img.shields.io/npm/v/@formstr/calendar-sdk)](https://www.npmjs.com/package/@formstr/calendar-sdk) | Headless SDK for the NIP-52 calendar protocol. |
| `@formstr/kanban-sdk` | [![npm](https://img.shields.io/npm/v/@formstr/kanban-sdk)](https://www.npmjs.com/package/@formstr/kanban-sdk) | Headless SDK for Nostr Kanban boards (public + NIP-100E private). |
| `@formstr/mailstr-sdk` | [![npm](https://img.shields.io/npm/v/@formstr/mailstr-sdk)](https://www.npmjs.com/package/@formstr/mailstr-sdk) | Headless SDK for Mailstr — Nostr-native email (claim, inbox, send). |
| `@formstr/core` | [![npm](https://img.shields.io/npm/v/@formstr/core)](https://www.npmjs.com/package/@formstr/core) | Nostr primitives: signers, relay/runtime plumbing, crypto, Blossom, linking. |
| `@formstr/agent` | [![npm](https://img.shields.io/npm/v/@formstr/agent)](https://www.npmjs.com/package/@formstr/agent) | The modules' service layer plus the shared 59-tool registry (DOM-free). |
| `@formstr/mcp` | [![npm](https://img.shields.io/npm/v/@formstr/mcp)](https://www.npmjs.com/package/@formstr/mcp) | Model Context Protocol server exposing the Formstr super-app to MCP hosts. |

## Layout

```
packages/
  signer/            @formstr/signer
  local-relay/       @formstr/local-relay
  calendar-sdk/      @formstr/calendar-sdk
  kanban-sdk/        @formstr/kanban-sdk
  mailstr-sdk/       @formstr/mailstr-sdk
  core/              @formstr/core
  agent/             @formstr/agent
  mcp/               @formstr/mcp
apps/
  tester/            @formstr/signer demo host
  local-relay-tester/
  kanban-tester/
```

`core` → `agent` → `mcp` is a layered stack: `core` is the shared Nostr protocol
layer, `agent` the shared behaviour (services + tool registry used by both the
in-browser assistant and the MCP server), and `mcp` one delivery mechanism (the
stdio server, including the keychain login). `mcp` bundles `agent` + `core` into a
single self-contained CJS file at build time, so its npm tarball has no workspace
references.

## Development

```sh
pnpm install
pnpm -r typecheck
pnpm -r test:coverage
pnpm -r build
```
