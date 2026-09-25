# @arcforge/cognet — The Cognet Runtime

## What This Is

Everything that executes **inside** a compiled brain. Public, published, and
installed into every agent — the generated entry imports it by bare specifier,
so the bundler resolves it from the agent's own node_modules.

The counterpart is `@arcforge/core`, which **loads** brains and stays private. The
dividing question for any file: *does this run inside the brain, or does it load
the brain?*

Extracted from `core/src/cognet/` once cognets became publishable registry
artifacts. Before that, `bundle.ts` imported the host by an absolute path into
core's source tree — which resolved only in this workspace, so a published CLI
(8 files, no source) could never have compiled a cognet at all.

## The Design

**Root export is minimal.** `CognetHost` and `defineCognet`, plus `Clock`. A
cognet cannot exist without the host; everything else is opt-in via subpath, so
a control loop that never queries an entity bundles no entity store.

```
.       CognetHost, defineCognet, Clock   — always needed
./ecs   entities, components, queries      — opt-in
```

The grammar a cognet renders with is **not here** — it is `@arcforge/air`, a
peer package. It lived under `./air` while the reasoning was "AIR is a
cognet's choice", but the kernel parses with the same grammar, and a subpath
of this package forced ring 0 to depend on the runtime it loads. See
`packages/air/CLAUDE.md` for the input/output split that replaced it.

**The clock is not the world.** `tick`/`phase`/`system` and their telemetry live
in `clock.ts`; entities/components/watchers live in `ecs/`. They were one module
(`ecs/state.ts` owned both), which meant every cognet carried an entity store to
get `phase()`. ECS now receives a `stamp()` from the clock so world mutations are
still attributed to a tick and phase without owning the counters.

**The tick counter is the cognet's, not the wake's.** `Clock()` is built per wake
because it carries that wake's abort signal — so a counter it owned restarted at
zero every time. Invisible for an invocation cognet (one wake, many ticks);
totally wrong for a continuous one, where every wake IS one tick, so every event
a 20Hz loop emitted was stamped `tick: 1`. `Ticks()` owns the counter at host
scope and is handed to each wake's clock.

**The world's lifetime is the cognet's, for the same reason.** It was documented
as a wake-scoped working set, re-derivable from the log. That holds for a
conversation turn and breaks for a control loop: the world would be rebuilt
twenty times a second, and beliefs that exist *because* they persist — a decaying
drive, a remembered place, how long a fall has lasted — could not be represented
at all. `ecs` is built lazily on first touch, so a cognet that never queries an
entity still carries no entity store.

**A component carries WHEN it was written.** Age is part of a belief's meaning:
"position, 50ms old" and "map of the cave, 40s old" are different epistemic
objects, and anything choosing between them has to tell them apart. The store
holds `{ data, at }` and `component.writtenAt()` reads it; the clock is injected
(`EcsOpts.now`) so staleness is deterministic in a test. The time advances on an
unchanged write too — a belief reaffirmed just now is current, not merely
unaltered, and only bumping it on change would make an unchanging belief look
steadily more doubtful the longer it stayed true.

**`ComponentDescriptor.workspace` marks the pool a mind may attend to.** The
world is everything a cognet stores, most of it machinery — raw sense vectors,
efference copies. The workspace is the subset worth a thought. It is a property
of the component TYPE, not of an instance: choosing between a hundred remembered
places is attention's job, and attention selects *from* this pool rather than
defining it. Declared rather than inferred from whatever an attention system
queries, because that puts the boundary in code — add a belief, forget to update
attention, and it silently never reaches cognition.

**Component writes carry their value and are gated at the write.** A write whose
value is structurally equal to the stored one emits nothing; the store still
updates and watchers still fire. That keeps the log a record of what *changed* in
the mind rather than a stream of identical snapshots, which is what makes it
affordable for this family to carry data at all — and carrying data is what makes
the world reconstructible rather than merely auditable. Shape is declared once per
component type (`ecs.declare()`), not repeated on every write.

**Importing `./host` installs the ambient globals** — `loop`, `kernel`, `phase`,
`system`, `ecs`, `defineCognet`, `definePlugin`. That side effect is why the generated
entry imports it first, before config and main evaluate. `definePlugin` is
global-only: it registers lifecycle hooks when called, so exporting it would
invite calling it outside a brain.

**A cognet learns nothing about its environment.** No blueprint, no config, no
paths. The `blueprint` ambient global was removed deliberately — a mind that
never knew what kind of world it was in doesn't need porting when the world
changes.

## Key Interfaces

```ts
CognetHost(config, main)        // config + wrapped main → the definition the kernel loads
defineCognet(config)            // identity, in cognet.config.ts
Ticks()                         // the cognet-lifetime tick counter
Clock({ emit, signal, ticks })  // runTick / runPhase / runSystem + the phase counter
Ecs({ emit, stamp })            // declare / entity / component / query / watch
```

The ABI itself (`KernelAbi`, `CognetConfig`, `CognetDefinition`) lives in
`@arcforge/types` — types are the contract, this package is the runtime.

## Versioning

Published in lockstep with `@arcforge/types`, `@arcforge/err`, and
`@arcforge/engines` by `apps/tui/scripts/release.ts`. The version is the cognet
bundle's cache key: a compile is invalidated by the cognet's own source or by a
runtime version bump, and by nothing else.

## Known Debt

- ECS telemetry volume is now gated at the write but has not been MEASURED
  against a real continuous world. Terry (`registry/agents/terry`) is the first
  one; whoever next touches it should check actual session-log growth at 20Hz
  before adding components.
- No tests for `host.ts` beyond lifecycle basics; coverage is strongest on ECS.
  AIR's own suite moved with it to `packages/air/tests` (148).
