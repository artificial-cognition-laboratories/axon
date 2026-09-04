
## [x] Eight in-process behaviour gaps from the subprocess port
**Severity:** medium
**Description:**
125 of 133 tests pass against the in-process capsule. The eight that do not are
behaviour the subprocess provided and the port has not yet reproduced: the
escalate no-callback default hangs rather than denying immediately, two tool
tests (declaration/export mismatch, tool-internal state across runs), the scope
size budget, the trusted host bridge (`axon.request()` from tool code is
stubbed `NOT_WIRED`), the process-globals passthrough, and the `process.run`
observable-mirror shape. Each is a real gap rather than a test that stopped
being true — they were kept precisely so the port could be measured against
them.
**Resolved:** the suite now runs 152/152 green. Verified while fixing the
spawn-lifetime bugs below; the count also grew, so this is not a case of the
gaps being deleted along with their tests.
**References:**
- libs/axon/packages/capsule/tests/ — run `bun test tests/` for the current set

## [ ] The kernel's capsule does not enter its configured cwd
**Severity:** medium
**Description:**
`InProcSandbox.boot()` chdirs into `config.cwd`, and a direct `Capsule({ cwd })`
honours it — verified with the kernel's exact config shape. But
`core/tests/integration/kernel/cwd.test.ts` still sees the host's directory,
so something on the kernel's own path (`AxonCapsule`) is not reaching that
boot, or is booting before the config is applied. Two tests fail. Worth
resolving because cwd is now PROCESS-GLOBAL: an agent that runs in the wrong
directory resolves every relative path in model code against the wrong root,
and the failure is silent rather than loud.
**References:**
- libs/axon/kernel/src/capsule.ts — config(), the boot call
- libs/axon/packages/capsule/src/inproc/capsule.ts — boot(), configuredCwd

## [ ] The scope size budget has lost its justification — keep or drop?
**Severity:** low
**Description:**
`SCOPE_BUDGET_CHARS` (2M chars) marks oversized bindings `unavailable` rather
than returning them. Its stated reason is that bindings "cross a process
boundary on every run", so a loop reading a repository into a local array would
put all of it on the wire whether or not a template named it. That cost no
longer exists — bindings are ordinary values in one heap and nothing
serialises them. The limit still has a defensible SECOND reason (a 3MB binding
retained across submissions is real memory in the agent's own heap, and a
runaway loop is worth catching), but that is a different argument and the
current comment does not make it. Either restate the justification and keep the
limit, or drop it as machinery that outlived its purpose. Left as a `.failing`
test rather than decided unilaterally: it is a user-visible limit.
**References:**
- libs/axon/packages/capsule/src/process/bindings.ts — SCOPE_BUDGET_CHARS
- libs/axon/packages/capsule/tests/execution/scope.test.ts — the pinned decision

## [x] process.spawn() reported a lifecycle it had not observed
**Severity:** high
**Description:**
`spawn()` stamped its entry `status: "running"` and returned the handle before
mediation or the OS spawn had happened, so `pid` was undefined and `running`
was a claim nobody had verified. A bare trailing `process.spawn(...)` in a
model block serialises the handle immediately, so this fiction is what reached
the model — an agent read it as an immediate exit and told the user the
environment could not hold background processes, while its `sleep 3600` ran
fine. Compounded by `air`'s renderer, which papered over the missing values
with `pid ?? "?"` and `status ?? "running"`, inventing a running status for an
unknown one. Fixed by adding a `pending` status and a `started` promise that
settles when the spawn launches or is refused (carrying the refusal reason), and
by deleting the renderer fallbacks.
**References:**
- libs/axon/packages/capsule/src/process/procs.ts — spawn(), markStarted, markExited
- libs/axon/packages/capsule/src/sandbox/procs/handle.ts — the `started` promise
- libs/axon/packages/capsule/types/process.ts — ProcStatus
- libs/axon/packages/air/src/render/output.ts — the `?? "running"` fallback

## [x] Managed spawns leaked their real workload on every kill
**Severity:** high
**Description:**
`spawn()` used `shell: true` without `detached`, so the tracked child was
`/bin/sh -c "<command>"` and `child.kill()` signalled only the shell. The
command itself was orphaned onto init and survived `kill()`, `interrupt()` and
`shutdown()` alike — an agent spawning ambient work leaked one process per
session with nothing reporting it. `run()` had this right (`detached` plus
`killTree`); `spawn()`, the path that exists specifically for long-lived
processes, did not. Fixed by making spawned children group leaders and killing
the group in `kill()` and `killAll()`.
**References:**
- libs/axon/packages/capsule/src/process/procs.ts — mediateAndSpawn, kill, killAll
- libs/axon/packages/capsule/tests/execution/process/lifetime.test.ts — the orphan test

## [x] No test asserted a spawned process stays alive
**Severity:** high
**Description:**
Every spawn test used a command that exits immediately (`echo`) and awaited
`.exited`, and one asserted `status === "running"` synchronously after spawn —
which passed against the optimistic fiction rather than reality. The suite would
have passed identically if `spawn()` never launched anything, and it did pass
while spawned processes were being orphaned on every kill. This coverage hole is
what let both bugs above ship. Closed with `lifetime.test.ts`, which asserts
liveness against the OS (`kill -0`) rather than against our own bookkeeping:
cross-block survival, reaping on shutdown, the grandchild dying with the shell,
and a refused spawn settling with its reason. Verified to catch the regression
by reverting the fix — 3 of 4 fail without it.
**References:**
- libs/axon/packages/capsule/tests/execution/process/lifetime.test.ts

## [x] A policy-denied call reported success
**Severity:** critical
**Description:**
`runOne` decided `ok` by asking "did the block throw", which is the wrong
question for a denial: nothing throws. A refused `process.spawn()` returns a
handle whose status is `exited`; a refused `process.run()` returns `{ok:false}`
as a VALUE. Neither propagated, so the kernel committed `cognet:action:result`
with `ok: true` and the durable record said a blocked call had worked. Observed
in a real session — `process:policy:denied` at seq 89, `process:proc:denied` at
90, and `cognet:action:result ok:true` at 92. The agent believed it held a
background process, the timeline drew an ordinary tool call, and the user's own
policy had stopped it with nothing anywhere saying so: a silent failure at the
one boundary the policy system exists to make visible. Fixed by collecting
denials per block (via the bus, so the throwing half — denied TOOL calls —
is classified too) and reporting `ok: false` with `error.kind: "policy"`, a
slot the entry ontology already had and nothing ever set. The block's value and
stdout are kept: a block that made ten calls and had one refused still did nine
real things.
**References:**
- libs/axon/kernel/src/kernel.ts — runOne, denialMessage
- libs/axon/packages/capsule/tests/policy/denial-result.test.ts
- libs/axon/core/tests/integration/kernel/policy/denied-result.test.ts

## [x] `process:policy:denied` was durable, complete, and read by nobody
**Severity:** high
**Description:**
The event carried the module, the verb, the args and the deciding rule, and no
surface anywhere consumed it — grepping `policy:denied` across `apps/tui`
returned nothing. It could not have been rendered even by a surface that wanted
to: it carried no `commandId`, so there was no way to say which `Run(...)` it
belonged to. Both mediators (the capsule's and the kernel's) now stamp the
executing block's id, read through the capsule's AsyncLocalStorage execution
store so concurrent blocks attribute correctly, and the timeline folds denials
onto their tool call. Two silent paths were also closed: a REFUSED escalation
emitted no denial at all in either mediator, so a call the user was asked about
and declined settled with the question on the record and never the answer.
**References:**
- libs/axon/packages/capsule/src/process/mediator.ts
- libs/axon/kernel/src/mediation.ts — also fixed `commandId: ""` on every span
- apps/tui/app/composables/timeline/fold.ts — attachActivities
- apps/tui/app/components/session/denial-row.vue

