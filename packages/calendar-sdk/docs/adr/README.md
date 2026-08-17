# Architecture decisions

Short records of decisions that are expensive to rediscover. Read the relevant
one before changing the behaviour it explains — each says what was tried and
what it cost.

| ADR | Decision |
|---|---|
| [0001](0001-protocol-source-of-truth.md) | The wire format is read from nostr-calendar's source, at a pinned SHA |
| [0002](0002-deliberate-parity.md) | Upstream behaviours that look like bugs and are kept anyway |
| [0003](0003-read-side-hardening.md) | Where the SDK is stricter than upstream, and why that is safe |
| [0004](0004-scope.md) | What the SDK covers, and what it deliberately leaves out |

The wire format itself lives in [`../protocol.md`](../protocol.md).
