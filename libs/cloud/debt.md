# @arcforge/cloud — debt

## [x] Agents and Modules carried full parallel CRUD over the artifacts rows
**Severity:** high
**Description:**
`Agent`/`Module` handles restated every verb `Artifact` already had — get,
publish, versions, downloadUrl, stats, star, unstar, update — against parallel
`/api/agents/*` and `/api/modules/*` route families that hit the same
`registry_artifacts` rows as `/api/artifacts/*`. Three clients, three route
families, one table. `Registry`'s own docstring already said agents and modules
remained only "for the verbs genuinely specific to them (deployment, npm-style
installs)"; the code had drifted past its stated design. This was not merely
duplication — three doors over one table is what let an agent-bound key be
refused at the agents door and admitted at the artifacts one (see the backend
debt entry), and it hid a second gap where the artifacts star route never
checked `canReadRegistryResource` while the modules one did.
**Resolved.** `Agents` now composes `Artifact` and adds only `deployment()`;
`Modules` keeps only `resolve()` (the npm install payload, genuinely not
`ResolvedArtifact`). `AgentRecord`/`ModuleRecord` and friends are documented
aliases of the artifact types rather than second definitions parsing identical
JSON into differently-named objects. `AgentStats.activeDeployments` was dropped —
served only by the retired agents stats route and read by nothing; the dashboard
takes that count from `user.overview()`.
Two capability gaps surfaced and were closed properly rather than papered over:
`artifacts.handle()` (+ one kind-agnostic `/api/registry/resolve-id` route)
restores name→handle lookup for an artifact with no published version, which
`resolve()` cannot do; and `publish()` now derives `requireImage` from the
handle's kind, so an agent bundle missing image.json still fails at the call
site without every caller having to remember.
**Follow-up: done.** The backend families were retired in a second pass once the
client no longer referenced them — 15 routes deleted (`/api/agents/[id]/*` minus
connect-token, all of `/api/modules/[id]/*`, `registry/agents/*`,
`registry/modules/index` and `resolve-id`). Verified by re-running every suite
against a restarted backend and by probing each retired path for a 404 while the
survivors answer. Two per-kind routes remain and earn it: `agents/[id]/connect-token`
(only agents run) and `registry/modules/resolve` (npm install payload, not
`ResolvedArtifact`).
**References:**
- libs/cloud/src/registry/agents/agents.ts — deployment only
- libs/cloud/src/registry/modules/modules.ts — install resolution only
- libs/cloud/src/registry/artifacts/artifacts.ts — handle(), kind-aware artifact()
- libs/cloud/src/registry/{agents,modules}/types.ts — aliases, not second definitions
- apps/backend/server/api/registry/resolve-id.get.ts — the kind-agnostic routing lookup

## [x] Bundle() was implemented three times
**Severity:** medium
**Description:**
`registry/agents/bundle.ts`, `registry/modules/bundle.ts` and
`registry/artifacts/bundle.ts` were near-identical: same 50MB cap, same
dir-or-tarball resolution, same `tool-globals.d.ts` lookup, differing only in
which manifest they keyed on and in error wording. Three copies meant three
places for the upload payload to drift from what the backend accepts, and the
artifacts copy — the one the live publish path actually used, since
`Publish()` goes through `registry.artifacts` for all four kinds — was the
only one with no tests at all.
**Resolved.** Collapsed to the artifacts implementation, which already
subsumed the other two (it resolves package.json in the bundle dir *or* its
parent, and reads `abi` from image.json). The agent-only requirement that
image.json be present is preserved as an explicit `requireImage` option rather
than dropped — an agent bundle without its build manifest still fails at the
call site with "run `axon build` first", not server-side with a 400. Two files
and ~150 LOC deleted; `artifacts/bundle.ts` went 0% → 100% funcs / 97.9% lines
with no new test file, because the existing agent and module bundle-error
suites now drive one implementation.
**References:**
- libs/cloud/src/registry/artifacts/bundle.ts — the surviving implementation
- libs/cloud/src/registry/agents/agent.ts — publishes with `requireImage: true`
- libs/cloud/src/registry/modules/module.ts — import swap only
- libs/cloud/tests/deployments/fixtures.ts — fixture now writes package.json, as `axon build` does

## [x] Device-flow login paid a full poll interval on every call
**Severity:** high (fixed)
**Description:**
`Auth.login()` typed `onVerification` as `=> void` and called it without
awaiting, so an async caller that approves the code inline had its promise
dropped. Polling then started before approval landed, missed on the first
attempt, and slept a full `POLL_INTERVAL_SECONDS` (5s) waiting for a state the
caller had already reached. Compounded by `device.wait()` sleeping BEFORE its
first poll rather than after. Both fixed: `onVerification` is now
`=> void | Promise<void>` and awaited, and the loop polls first. Every
device-flow test dropped from ~5s to milliseconds — the tui refresh suite went
20.75s → 778ms.
**References:**
- libs/cloud/src/user/auth/auth.ts
- libs/cloud/src/user/auth/device.ts
- apps/tui/platform/services/cloud.ts

## [ ] Engine tests spend real money on every run
**Severity:** medium
**Description:**
`tests/cloud/engine.test.ts` calls real inference twice per run. The backend's
`MockUpstream` was removed deliberately (see `platform/engine/engine.ts` — "no
environment flag that silently swaps real inference for fake"), and the
sanctioned mock, `Mock()` from `@arcforge/engines`, is agent-side and never
reaches `/api/engine/stream`. So the metering path has no deterministic
substitute: the tests now assert invariants (a stream terminates with an
authoritative done; the done frame's cost equals the ledger debit) rather than
fixtures, which is correct but costs a few tenths of a penny each run. The
prompt is kept minimal for that reason. If the cost or flakiness bites, the fix
is an explicitly-named mock model in the catalog — asked for by name, never
swapped in by an env flag — not a return of the staging mock.
**References:**
- libs/cloud/tests/cloud/engine.test.ts
- apps/backend/platform/engine/engine.ts

## [ ] API_KEY_SCOPES is a hand-maintained duplicate
**Severity:** medium
**Description:**
`src/user/keys.ts` mirrors `apps/backend/platform/auth/scopes.ts` by hand. It
drifted — 11 entries against the backend's 19 — when cognets and benches became
registry artifacts, and the device-flow test failed for a week because it
asserts a session's granted scopes against this copy. Both are now in sync, but
nothing enforces that. The clean version is one exported constant both sides
import, which means moving it to `@arcforge/types`.
**References:**
- libs/cloud/src/user/keys.ts
- apps/backend/platform/auth/scopes.ts
- apps/backend/supabase/seed.sql

## [ ] Deployment tests encode wall-clock respawn budgets, tuned on an idle machine
**Severity:** medium
**Description:**
`tests/deployments/` waits on real `bun run` subprocesses respawning, with
hardcoded budgets. They passed for a year because the suite only ever ran alone.
Adding `fleet` to the ship gate chains cloud immediately after platform's 737
tests at `--parallel=4`, and at a load average of ~6 two respawn tests exceeded
their 30s budgets — a red gate from timing, not from a defect. Budgets were
raised (inner waits to 60s, outer per-test to 90-300s so the outer always clears
the sum of the inner waits it contains; otherwise Bun kills the test before it
can report why it gave up). This is a mitigation, not a fix: the tests still
assert "fast enough" rather than "respawned", so they will drift red again on a
slower or busier machine. The clean version polls a readiness signal with no
wall-clock ceiling and fails only on an explicit terminal state.
**References:**
- libs/cloud/tests/deployments/secrets.test.ts — readEnvUntil(), 60s poll
- libs/cloud/tests/deployments/lifecycle.test.ts — waitUntilReady budgets
- apps/backend/platform/gcloud/mock-deployments.ts — spawn(), the real subprocess
- libs/repo/src/ship/targets.ts — fleet chains platform then cloud
