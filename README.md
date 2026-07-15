# Common Packages for formstr

Shared packages used across Formstr / Nostr ecosystem apps. pnpm monorepo
(`packages/*` + `apps/*`).

## Packages

| Package | Published | Description |
| --- | --- | --- |
| [`@formstr/signer`](packages/signer) | npm | Nostr signer with login UI for NIP-07, NIP-46, NIP-49 (ncryptsec), and NIP-55. |
| [`@formstr/local-relay`](packages/local-relay) | npm | NIP-01 Web Worker local relay + intent-only data layer for Nostr apps. |
| [`@formstr/core`](packages/core) | npm | Nostr primitives for Formstr: signers, relay/runtime plumbing, crypto, Blossom, cross-module linking. |
| [`@formstr/agent`](packages/agent) | npm | Formstr service layer + tool registry (DOM-free; runs in browser and Node). |

## Development

```bash
pnpm install
pnpm -r typecheck
pnpm -r --if-present test:coverage
pnpm -r build
```

> Note: `esbuild` is pinned to a single version workspace-wide via a `pnpm.overrides`
> entry in the root `package.json`. Under the corepack-pinned `pnpm@9.0.0`, letting
> multiple `esbuild` versions coexist makes esbuild's postinstall mis-resolve its
> platform binary; a single version avoids that.
