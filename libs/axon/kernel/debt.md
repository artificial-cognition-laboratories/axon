# @arcforge/kernel — debt

## [ ] A tool already inside `await` cannot be cancelled
**Severity:** medium
**Description:**
An interrupt aborts the wake immediately and every layer honours it: the
scheduler aborts, the engine stream passes its signal to `fetch` and the SSE
reader, and `procs.run` kills the spawned process tree. What is NOT cancellable
is a tool that has already entered an `await` — `execution.run` is
`AsyncLocalStorage.run`, which makes the signal *available* but never races it,
so the enclosing `await` returns only when the tool does. Measured: an abort at
200ms into a 3s operation returns at 3001ms.

Mitigated, not fixed. The kernel now refuses to START a script once the wake is
cancelled (`runAndCommit`), so a turn emitting many blocks stops at the next
block instead of running all of them — the destructive case (a sequence of small
writes continuing past Escape) is closed. The TUI separately settles pending
activity rows on interrupt, so nothing claims to still be working.

What remains is the in-flight tool itself: an `@axon/fs` glob scan over a large
tree, or any single long `await`, still runs to completion after the interrupt.
The clean fix is threading the wake signal into module tools, which is
DELIBERATELY off the table — cancellation must not become a contract tool
authors have to implement, or every module that forgets one is silently
unkillable. A kernel-side fix (racing the signal against the tool's promise)
would abandon the tool mid-write rather than cancel it, trading a stuck spinner
for a partial write; that trade needs a decision, not a patch.

**References:**
- libs/axon/packages/capsule/src/process/execution.ts — `AsyncLocalStorage.run`, no race
- libs/axon/packages/capsule/src/process/runner.ts — `await execution.run(...)`, settles activities only after it returns
- libs/axon/kernel/src/kernel.ts — `runAndCommit` / `runBatch`, the boundary check that mitigates it
- libs/axon/packages/capsule/src/process/procs.ts — the path that DOES cancel (kills the process tree)
- apps/tui/app/composables/timeline/fold.ts — `settlePending`, the UI half
