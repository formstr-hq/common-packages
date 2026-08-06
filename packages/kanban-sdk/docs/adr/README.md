# Architecture decisions

One file per decision that changed the wire format or would otherwise be
re-litigated. Each says what changed, why, and what it costs.

The protocol itself lives in `kanban/docs/` (`05` spec, `07` gaps). These records
explain choices the spec text does not, and supersede it where they say so.

| ADR | Decision |
|---|---|
| [0001](0001-invitation-wrap-kind.md) | Invitation wraps are kind 1059, typed by `["k","1053"]` |
| [0002](0002-invitation-dismissal.md) | Dismissal deletes the wrap with its own ephemeral key |
| [0003](0003-removal-notice.md) | The kind-84 removal notice carries only a blinded pointer |
