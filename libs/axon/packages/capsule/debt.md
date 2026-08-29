
## [ ] Eight in-process behaviour gaps from the subprocess port
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
