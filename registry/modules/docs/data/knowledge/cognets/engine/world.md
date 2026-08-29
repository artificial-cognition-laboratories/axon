---
title: The World
description: The entity-component model behind the clock, and why cognition is shaped like a game world.
---

# The World

Every wake constructs a world: a set of entities, the components attached to them, queries
over both, and the tick/phase clock. It is built fresh when the wake starts and dies when
the loop stops.

Today a cognet touches one part of it directly — the clock, through `phase()` and
`system()`. The entity-component surface is live in the engine and drives telemetry, but
it is not yet exposed as an authoring API. This page describes the model, why it exists,
and what is reachable now.

## Why cognition is shaped this way

The honest reason isn't the game-dev pedigree. It's this:

> **A mind that must be rebuildable from a log cannot hold state that isn't serializable.**

That's a hard constraint, and most data models fail it quietly. Objects with methods,
class hierarchies, closures capturing other closures, cyclic references between live
handles — all easy to write, and impossible to reconstruct faithfully from a replay.

Entity-component storage fails it *loudly* instead, because it cannot represent those
shapes at all. An **entity** is an id. A **component** is a typed record attached to that
id. Storage is flat maps. There is nowhere to hide a function, nowhere to build a cycle,
and nothing that means something different after a restart than it did before.

So the property [Memory](/docs/v2/cognets/engine/memory) depends on — resident state is a
projection of the log, lose it freely — stops being a discipline you maintain and becomes
a shape you can't escape.

Game engines converged on ECS for cache locality and composition over inheritance. Those
benefits are real. But they're corroboration, not the reason. The reason is that a
serializable world is a rebuildable one.

## The clock

This is the part a cognet drives today.

```ts
loop(async ({ stop }) => {
    const observations = await phase("sense", async () => {
        return readEverythingNew()
    })

    await phase("think", async () => {
        await system("score-candidates", async () => { /* ... */ })
        await system("pick-action", async () => { /* ... */ })
    })

    stop()
})
```

`tick`, `phase`, and `system` are the only writers of the world clock. Every component
and entity mutation the engine performs is stamped with the tick and phase it happened
in, which is what makes the mutation history replayable against the clock rather than
just a flat log of writes.

`phase()` names a stage and sets `state.phase` for its duration. `system()` names a unit
of work inside a phase and times it. The naming is ECS naming on purpose: a system is
work that runs against the world.

See [The Loop](/docs/v2/cognets/engine/loop) for the full semantics.

## The component model

Components are typed through a registry extended by declaration merging:

```ts
declare module "@arcforge/core" {
    interface ComponentRegistry {
        position: { x: number; y: number; z: number }
        velocity: { dx: number; dy: number; dz: number }
        goal: { text: string }
    }
}
```

The registry is empty by default — a cognet declares the vocabulary of its own world, and
every query is typed against it.

Writes go through a single path. `Entity.add()` delegates to `Component.add()` rather
than touching storage, so there is exactly one place a component can change. That is what
makes telemetry and watchers reliable rather than best-effort, and it is why watchers can
fire synchronously inside the write.

Queries narrow in four steps:

| Field | Effect |
|---|---|
| `with` | entity must hold every listed component; they arrive typed in the result |
| `without` | entity must hold none of the listed components |
| `where` | exact-match on component values |
| `filter` | arbitrary predicate over the typed result |

Intersection starts from the smallest matching store, so a query joining a rare component
against a common one costs the size of the rare one.

## Every mutation is telemetry

World writes emit as cognet telemetry, stamped with tick and phase:

```ts
"cognet:entity:add"       // { tick, phase, entity }
"cognet:entity:remove"
"cognet:component:add"    // { tick, phase, entity, component }
"cognet:component:update"
"cognet:component:remove"
```

The world isn't only queryable at runtime — its entire mutation history is recorded
against the clock, so you can replay exactly which phase of which tick added, changed, or
removed anything.

These land in the log's telemetry view and forward to the runtime bus — debugging record,
never rendered to the user as part of the conversation. See
[Observability](/docs/v2/cognets/engine/observability).

## The world is per-wake

The world dies when the wake ends, and that is deliberate.

It is a **working set** — the structured view a wake builds in order to think. It is not
memory. Persistence lives in the session log; durable cognitive state lives in
`kernel.store`. If an entity matters beyond this wake, it was derived from something in
the log, and the next wake derives it again.

`zero` sits at one extreme: it holds no entities at all. Its resident model is the folded
log, and it uses the world purely for `phase()` timing. That is a legitimate way to use
the engine — the world is available, not mandatory.

A perception stack sits at the other: hundreds of entities rebuilt from sensor stimuli
every tick, queried, acted on, discarded. Same machinery, opposite fill rate.

## What's reachable today

| Surface | Status |
|---|---|
| `phase()` / `system()` | ambient globals, available now |
| tick clock and its telemetry | driven by the host, emitted automatically |
| entity / component / query / watch | live in the engine, not yet exposed to cognet source |
| `ComponentRegistry` | declared and typed, ready for the authoring surface |

The engine builds a world for every wake regardless, because the clock and its telemetry
depend on it. Exposing the entity-component surface to authors is a deliberate next step
rather than an oversight: it wants a real workload — most likely the first continuous
cognet — to settle what the ambient API should look like before it becomes contract.

Until then, a cognet's world model is whatever it holds in module scope, and `zero`'s
log-shaped approach is the reference pattern.
