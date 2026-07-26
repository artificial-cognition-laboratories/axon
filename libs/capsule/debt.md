# Capsule — Debt Ledger

## [x] Tool scope-mismatch throws a raw Error, not a structured err()
**Severity:** low
**Description:**
RESOLVED. The throw already used `err("CAPSULE_TOOL_SCOPE_MISMATCH")` correctly;
the failing test was asserting the code string appeared in the error *message*,
which it does not (the message is the human detail). Fixed the test to assert
`.code === "AX-CAPSULE-002"`. During the same pass, every other raw `new Error`
in the capsule that represented a real failure condition was converted to a
coded `err()` with a map entry (boot, spawn, wire, capsule-down, already-booted,
install, host-unavailable, scope-violation). Legitimate control-flow errors
(abort/cancellation) and wire-relayed remote errors were deliberately left raw.
**References:**
- libs/axon/packages/capsule/src/build/tools.ts
- libs/axon/packages/capsule/tests/execution/tools.test.ts

## [x] Tools loaded by path forced mounting the project into the box
**Severity:** high
**Description:**
RESOLVED. Tools with a raw `entryPath` were `import()`ed inside the sandbox,
which required mounting the tool file (and, to satisfy its imports, an ancestor
that re-exposed project data — the same class of leak as the runtime-deps
mount). Now scan bundles each `src/tools/*.ts` to self-contained ESM source
(off-thread Bun.build worker, content-hash cached, rides the watcher→rescan
reload path). The capsule receives `source`, materializes it inside the box, and
imports that — no tool file or project dir is mounted. Local and deployed tools
are now identical (both `source`), honoring the no-dev/prod principle. Proven
e2e: a confined box loads a bundled tool AND blocks a sibling secret
simultaneously.
**References:**
- libs/axon/tui/platform/build/blueprint/scan/tool-bundle-worker.ts — the bundler
- libs/axon/tui/platform/build/blueprint/scan/tools.ts — cachedToolBundles(), source emission
- libs/axon/core/src/kernel/capsule.ts — toCapsuleTools() prefers source over path

## [x] Relative fs policy paths resolve against launch dir, not the agent project root
**Severity:** medium
**Description:**
RESOLVED. `policy.fs` paths are now resolved against the agent project root
(`blueprint.paths.root`) in the kernel's defaultPolicy(), before the policy
reaches the capsule — so `fs: { read: ["./workspace"] }` means
`<project>/workspace` regardless of where axon was launched. Absolute paths pass
through unchanged. The capsule still resolves against cwd as defense-in-depth for
programmatic callers.
**References:**
- libs/axon/core/src/kernel/capsule.ts — resolveFsPaths() against blueprint.paths.root

## [x] Hot reload did not re-apply policy (removed policy silently retained)
**Severity:** high
**Description:**
RESOLVED. Commenting out `policy` in axon.config.ts hot-reloaded the agent but
left the OLD policy in force (confined sandbox never relaxed until a full
restart). Cause: mergeBlueprint() deep-merged config, so a field ABSENT from the
reloaded file meant "keep the old value" rather than "author removed it". Fixed
by giving update() two modes: "merge" (default; partial programmatic updates keep
absent fields) and "replace" (the config file is authoritative — absent config
fields are dropped). The file-reload path (agent.ts watcher) now passes
mode:"replace"; identity/paths/cognet are always preserved. Locked by tests in
reload/engine-swap.test.ts (both modes).
**References:**
- libs/axon/core/src/platform/blueprint.ts — mergeBlueprint(current, partial, mode)
- libs/axon/core/src/runtime/runtime.ts — update(partial, { mode })
- libs/axon/tui/platform/build/agent/agent.ts — reload passes mode:"replace"
