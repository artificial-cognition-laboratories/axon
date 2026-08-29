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

**Importing `./host` installs the ambient globals** — `loop`, `kernel`, `phase`,
`system`, `defineCognet`, `definePlugin`. That side effect is why the generated
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
Clock({ emit, signal })         // runTick / runPhase / runSystem + the tick/phase counters
Ecs({ emit, stamp })            // entity / component / query / watch
```

The ABI itself (`KernelAbi`, `CognetConfig`, `CognetDefinition`) lives in
`@arcforge/types` — types are the contract, this package is the runtime.

## Versioning

Published in lockstep with `@arcforge/types`, `@arcforge/err`, and
`@arcforge/engines` by `apps/tui/scripts/release.ts`. The version is the cognet
bundle's cache key: a compile is invalidated by the cognet's own source or by a
runtime version bump, and by nothing else.

## Known Debt

- The entity/component surface is live but not exposed to cognet source as an
  ambient global — only `phase`/`system` are. Waiting on a real workload (most
  likely the first continuous cognet) to settle what the authoring API should be.
- No tests for `host.ts` beyond lifecycle basics; coverage is strongest on ECS.
  AIR's own suite moved with it to `packages/air/tests` (148).
