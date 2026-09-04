# @arcforge/core — The Axon Runtime

## What This Is

The agent runtime: `Axon()` composes a blueprint, a kernel, a cognet, modules
and a server into one running agent. Consumers are the TUI, the CLI, the Fleet
extension and a deployed container — all through `Axon()` or the HTTP surface
it builds.

## The Design

**`Axon()` is wiring only.** It normalises the blueprint at one seam, builds
each handle in dependency order, and hands the assembled set to `AxonRuntime`.
Nothing in it does work; anything that can fail does so at the call site that
needs it, not at boot.

**Session is environmental, not kernel-owned.** Constructed at the `Axon()`
seam alongside bus and cloud, and handed to every consumer that needs it. The
kernel's only relationship to it is mediating the cognet's access — the ABI's
`output()`/`run()` are the one privilege boundary, and the untrusted cognet may
emit or request but never read or write the log directly.

**`src/tools/` is the in-process tool manager.** Added for the agent-process
reshuffle. It replaces the capsule's split machinery — a guest-side loader plus
a host-side wire handshake that sent `tool:load` and awaited a confirmation
event — with one operation:

```
Tools({ mediation })   install(tools) → load, mediate, place into globals
  load.ts              import the module, wrap every export
  mediate.ts           policy check + fn:start/complete/failed spans
```

The mediation wrapper moved intact from the capsule: it was never about the
process boundary and works identically in one heap. What CHANGES is its role.
Once the whole agent runs inside an OS box, bwrap is the security wall — a path
outside the policy does not exist, a denied network has no socket — and this
becomes the AUDIT and ESCALATION layer: typed denials the model can reason
about, human-in-the-loop prompts the OS cannot express, and the span stream
Fleet folds into its flame graph.

**A broken tool now fails loudly.** The capsule's loader caught every failure,
emitted `capsule:tool:load:failed` and returned normally; the host half
listened for that event and rejected the build. Two halves of one decision
joined only by an event name crossing a wire, with nothing in the type system
connecting them. In one process that catch would be a silent swallow — an agent
running with a namespace the model was told it can call — so `loadTool` throws.

**The tool BOUNDARY is gone; the tool SCOPE is not.** What the model is told it
can call stays a curated declaration derived from the blueprint
(`@arcforge/kernel`'s `isLoadable`/`toScope`), never a reflection of whatever
is in the process. Otherwise the model would see `require`, `globalThis` and
every transitive dependency, and no editor `.d.ts` could be generated. What can
run, what the model is told it can call, and what an editor typechecks against
are one list by construction.

## Key Interfaces

```ts
Axon({ blueprint, cwd?, cloud?, host?, escalate? })  // the runtime
Tools({ mediation })                                  // in-process executable scope
  .install(tools) / .reload(tools) / .remove(ns) / .clear()
  .globals()      // flat, origin-aware — backs the ambient scope
  .namespaced(declared?)  // by namespace — backs axon.tools.*
```

## Two Tool Surfaces, One Gate

A tool's exports reach callers two ways, and both go through the same mediator:

- **Flat globals** — the primary path. `export function add()` is `add()`, in
  model-emitted code, scripts, routes, hooks and prompts alike. Placement
  follows ORIGIN: the agent's own `src/tools/` and the shared workspace's go
  flat; a MODULE's tools live under the module's name (`github.openPr()`), so
  an installed module cannot claim a bare name in the author's scope.
- **`axon.tools.<ns>.<fn>()`** — the ESCAPE HATCH, for when a bare name cannot
  serve: the name is already taken (a tool exporting `fetch` never replaces the
  host builtin, so this is the only way to call it), or the caller wants to be
  explicit about which tool it means.

Both are projected from the same loaded set — one loader, one `mediate()`
wrapper — so policy, tracing and escalation cannot drift between them. Both are
thunks read through getters, never snapshots: a hot reload rebuilds the set
(`Tools.reload()`), and a captured map kept serving tools the author had
deleted while newly added ones stayed unreachable until restart.

A namespace the blueprint declares but nothing could load is PRESENT in
`axon.tools` and rejects when called, naming itself. Absent, the call dies as a
property error pointing at the caller; no-op'd, it reports success for work
that never happened. Neither says the true thing.

**Mediation is the gate, and survives the boundary's removal.** `Mediation()`
in `@arcforge/kernel` gates in-process calls against the SAME resolved policy
the capsule enforces — `defaultPolicy()` is exported precisely so there is one
resolution, since two would let a tool be permitted on one path and denied on
the other with nothing to say which is right. The policy ADDRESS stays
`<namespace>.<fn>` on both surfaces even though the global is flat: a rule is
written against the tool the user installed, and a bare export name would make
one rule cover every module exporting `read`. Event names are unchanged
(`capsule:fn:*`, `capsule:policy:*`), because Fleet folds its flame graph
straight out of them.

Once the OS wall exists, this layer is DEMOTED rather than removed: bwrap
becomes the security boundary, and mediation becomes audit and escalation. The
OS cannot say "ask the user about this one command", and a denial arriving as
ENOENT teaches the model nothing — a typed refusal it can reason about is worth
more than a syscall error it cannot.

## Known Debt
- Scripts, routes and the cognet all run unsandboxed in the host process today
  while model-emitted code runs boxed. That split is the reshuffle's whole
  subject — see `tests/integration/confinement/cognet-network.test.ts`, which
  is red on purpose and defines done.
