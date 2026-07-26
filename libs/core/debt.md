# @axon/core — Debt Ledger

## [x] /_axon/* endpoints unauthenticated — v1 connect gate built (verify-callback)
**Severity:** critical → resolved for v1
**Description:**
RESOLVED (v1): `/_axon/{request,stream}` are now gated by `ConnectAuth` (connect-auth.ts).
A deployed agent (env `AXON_API_BASE` + `AGENT_ID` present → enforcing) POSTs the caller's
bearer token to the backend `POST /api/agents/:id/verify-connect`, which resolves it
(existing `Tokens.resolve`) and checks the caller can manage the agent (`canManageRegistryResource`
— owner/org, v1 access model). Fails CLOSED (503) if the control plane is unreachable/errors.
Health stays open (startup probe). Locally (no env) the gate is open. `AxonCloud.attach()`
presents the user's own token by default.

FUTURE (not v1, not blocking): the credential model's stateless RS256 JWT
(`AXON_CONNECT_TOKEN` verified against `AXON_JWT_PUBLIC_KEY` locally, no per-request backend
hop) is the long-term design. The verify-callback adds one backend round-trip per gated
request — acceptable for v1, swap to signed-token verification when latency/scale warrants.
Per-caller grants (beyond owner/org) also deferred.
**References:**
- libs/axon/core/src/runtime/server/connect-auth.ts — the gate (fail-closed)
- libs/axon/core/src/runtime/server/endpoints.ts — request/stream gated, health open
- apps/backend/server/api/agents/[id]/verify-connect.post.ts — the control-plane verdict
- apps/backend/platform/gcloud/run.ts — injects AXON_API_BASE (switches gate to enforcing)


## [ ] `globalThis.axon` is not instance-scoped — unsafe under multiple concurrent Axon()
**Severity:** high
**Description:**
`Inject().runtime()` writes the live handle to a single `globalThis.axon` slot (last
writer wins). The codebase explicitly runs several Axon() instances per process (the TUI
spawns one per conversation — see agents.ts, home.ts, session.ts). So any userland code
that reaches the injected `axon` global — tools, scripts, boot.vue — can bind to whichever
instance booted last, a silent cross-instance leak. `args` already dodges this via
AsyncLocalStorage (inject.ts:5,46,51); `axon` was never given the same treatment. Server
plugins are now safe (the handle is passed to fn(axon), not read from the global), but the
broader injected-global model is still exposed. The clean version: run each instance's
userland execution inside an ALS context carrying that instance's handle, and make
`globalThis.axon` a getter resolving `axonStorage.getStore()` — exactly the `args` pattern.
Resolve before the TUI ships concurrent instances to users.
**References:**
- libs/axon/core/src/platform/inject.ts — `runtime()` bare `g.axon = axon`; `args` shows the ALS pattern to mirror
- libs/axon/tui/platform/build/agent/agents.ts — spawns concurrent in-process Axon() instances


## [ ] Lifecycle hooks `server:ready` and `axon:agent:shutdown` are never fired by core
**Severity:** medium
**Description:**
The module setup executor now runs `defineModule().setup()` at boot, which surfaced a
pre-existing gap: modules register handlers on lifecycle hooks that core never triggers.
`axon:agent:shutdown` (used by github/lsp/telegram for teardown) was migrated to the new
`ctx.onDispose()` mechanism, but `server:ready` — which telegram uses to start its
long-polling loop after the server is up — is still never fired anywhere in core. Under
the rebuilt runtime, telegram's polling loop therefore never starts. The clean version:
core defines the canonical set of lifecycle hooks a module may hook (`server:ready`,
`boot:after`, etc.), fires them at the right point in the boot/reload sequence, and the
module setup contract documents which are available. Until then, any module relying on
`server:ready` is silently inert.
**References:**
- libs/axon/registry/modules/telegram/module.config.ts:59 — `axon.hook("server:ready", …)`
- libs/axon/core/src/runtime/runtime.ts:174 — only `boot:after` is fired, and only to plugins
- libs/axon/core/src/modules/index.ts — setup runs before the server is built


## [ ] capsule.ts liveCwd feature — origin unverified (resurrected from an old stash)
**Severity:** low
**Description:**
`AxonCapsule`'s `liveCwd`/`captureLiveCwd` (agent cwd persisting across capsule
reloads) was NOT in the last-good modern tree (`7bd50eaab`) — it came back in via a
104-commit-old stash that a bad `git stash pop` spliced into the tree during the
July 23 recovery. It is internally coherent (def once, called twice, safe fallback
to `opts.cwd`) and harmless, so it was KEPT during cleanup rather than reverted.
Cody could not confirm from memory whether this was intended work. Verify the cwd-
across-reload behavior is wanted and correct; if not, revert `capsule.ts` to the
modern version. The clean version: whatever the intended reload-cwd contract is,
made explicit with a test in `scope/declarations`.
**References:**
- libs/axon/core/src/kernel/capsule.ts — liveCwd, captureLiveCwd

## [ ] ABI payload types are versioned by convention, not mechanism
**Severity:** medium
**Description:**
`KERNEL_ABI_VERSION` guards the syscall signatures, but the real contract
surface includes every payload type `abi.ts` references (thread events,
engine request/events, cognet event map). The freeze rule is now documented
in `abi.ts`, but nothing enforces it — a payload change without a version
bump lets a stale cognet bundle load cleanly and misread events at runtime.
The clean version: when the kernel is extracted into its own package, the
ABI and its payload types move together into one frozen module whose public
surface is snapshot-tested per version.
**References:**
- libs/axon/types/src/kernel/abi.ts
- libs/axon/types/src/session/events/entries.ts
- libs/axon/types/src/session/events/engine.ts
- libs/axon/types/src/session/events/cognet.ts

## [ ] CognetHost module state limits one live brain per process (live-definition path)
**Severity:** low
**Description:**
`CognetHost` holds the registered loop, bound kernel, and blueprint in
module scope. The BUNDLE path is now safe for multi-instance: resolve()
cache-busts with a per-load nonce (hash stays the integrity check), so two
Axon() instances of the same agent each get a fresh module instance —
their own resident RAM. What remains is the LIVE-definition path (tests
passing `cognet.definition` directly): those compose through the one
shared CognetHost module and still clobber each other. Becomes real work
only if tests need two live-definition runtimes in one process (the same
moment `phase()`/`system()` need AsyncLocalStorage).
**References:**
- libs/axon/core/src/cognet/host.ts
- libs/axon/core/src/cognet/cognet.ts — resolve()'s nonce

## [ ] Engine abort surfaces as kernel:engine:failed telemetry
**Severity:** low
**Description:**
When a wake is interrupted mid-inference, the driver's abort throw passes
through `Engine.stream`'s catch and emits `kernel:engine:failed` before the
executor correctly records the run as interrupted. The run record is right;
the engine telemetry mislabels a user interrupt as a failure. Fix is to
check the abort signal (or an abort-shaped error) before emitting failed —
needs the signal plumbed into the engine layer or a typed abort error.
**References:**
- libs/axon/core/src/kernel/engine.ts — catch block around the driver stream
- libs/axon/core/src/kernel/executor.ts — Wake.execute interrupt handling
