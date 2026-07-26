# Debt — @axon/docker

## [ ] CLAUDE.md Known Debt is stale — claims /_axon/* is unauthenticated
**Severity:** medium
**Description:**
This package's CLAUDE.md still lists "`/_axon/*` is UNAUTHENTICATED (critical) — a deployed
agent with public ingress is open to anyone with the URL" as open debt. That was resolved:
`ConnectAuth` (libs/axon/core/src/runtime/server/connect-auth.ts) now gates
`/_axon/{request,stream}` and fails closed when the control plane is unreachable — see the
resolved entry at the top of libs/axon/core/debt.md. The write-up matters more than usual
now that this package is mirrored to the public `axon` repo: a stale note advertising an
unpatched hole in deployed agents is worse than no note. Update the Known Debt section to
describe the shipped v1 gate and the deferred RS256 work.
**References:**
- libs/axon/packages/docker/CLAUDE.md — Known Debt, first bullet
- libs/axon/core/debt.md — the resolved entry with the real state
- libs/axon/core/src/runtime/server/connect-auth.ts — the gate

## [ ] lifecycle.ts imports the private TUI package
**Severity:** medium
**Description:**
`lifecycle.ts` imports `Blueprint` from `@arcforge/axon/platform/build/blueprint` — the
private TUI package, reached past its index at an internal path. Two problems: it crosses
the public/private seam (this package is mirrored to the OSS repo, `@arcforge/axon` is
not, so the mirrored tree references a package that will never be there), and it violates
the module boundary rule by importing a deep internal path rather than a package index.
`Blueprint()` is a blueprint-scanning concern, not a TUI concern — it belongs in core or
its own package that both the TUI and docker consume.
**References:**
- libs/axon/packages/docker/lifecycle.ts:2 — the import
- libs/axon/tui/platform/build/blueprint — where Blueprint currently lives
