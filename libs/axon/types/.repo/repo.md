---
name: "@axon/types"
kind: library
---

# @axon/types

Shared type definitions across the Axon runtime. The single source of truth
for cross-package contracts — `AxonHandle`, `EngineConnection`, `RunningRecord`.

## Boundaries

Depends on nothing else inside the monorepo. Every other package may depend
on this one; this one may depend on none of them.

## Conventions

Types only. No runtime code, no side effects, no value exports.
