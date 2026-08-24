---
title: Observability
description: A thought, recorded as a flame graph — the cognet event vocabulary.
---

# Observability

The hardest part of building a mind is not making it work. It is finding out what it did.

A cognet emits its own structured record as it thinks: every tick, every named phase,
every unit of work, every world mutation — each one stamped with where it sat in the
clock. Not logging you add afterward. The execution wrappers you already use to structure
the loop are the same ones that produce the trace.

```ts
await phase("think", async () => {
    await system("score-candidates", async () => { /* ... */ })
})
```

That code emits `cognet:phase:start`, `cognet:system:start`,
`cognet:system:complete` with a duration, and `cognet:phase:complete` — in order, tick-
and phase-stamped. You get the trace because you named the stage, not because you
instrumented it.

## The vocabulary

Restricted to `cognet:*`, enforced at the call site rather than only in the types. A
cognet narrates its own world; it can never forge kernel machinery events like engine
calls or run records.

**The world clock**

```ts
"cognet:tick:start"        // { tick }
"cognet:tick:complete"     // { tick }
"cognet:tick:failed"       // { tick, error }
"cognet:tick:interrupted"  // { tick }
```

**Phases — named stages within a tick**

```ts
"cognet:phase:start"        // { tick, phase }
"cognet:phase:complete"     // { tick, phase }
"cognet:phase:failed"       // { tick, phase, error }
"cognet:phase:interrupted"  // { tick, phase }
```

**Systems — units of work within a phase**

```ts
"cognet:system:start"        // { tick, phase, system }
"cognet:system:complete"     // { tick, phase, system, durationMs }
"cognet:system:failed"       // { tick, phase, system, error }
"cognet:system:interrupted"  // { tick, phase, system }
```

**World mutation**

```ts
"cognet:entity:add"        // { tick, phase, entity }
"cognet:entity:remove"     // { tick, phase, entity }
"cognet:component:add"     // { tick, phase, entity, component }
"cognet:component:update"  // { tick, phase, entity, component }
"cognet:component:remove"  // { tick, phase, entity, component }
```

Every payload carries `tick`, and everything below tick level carries `phase`. That is
what makes the stream a tree rather than a list: start and complete events nest by
construction, so a flame graph falls out of the ordering without any correlation ids to
join on.

## Interrupted is not failed

The distinction runs through the whole vocabulary, and it matters more than it looks.

When a wake is aborted — the user pressed Escape, the process is shutting down — whatever
the in-flight phase threw is cancellation surfacing through the call stack, not a failure
of that phase's work. The wrappers check the wake's signal before classifying:

```ts
catch (cause) {
    if (signal?.aborted) {
        void emit("cognet:phase:interrupted", { tick, phase: name })
        throw cause
    }
    void emit("cognet:phase:failed", { tick, phase: name, error: err(cause) })
    throw failure
}
```

A system that conflates the two produces a trace full of red that means nothing. Every
user interrupt looks like a crash, and real crashes stop standing out. Keeping them
separate is what lets "failed" retain its meaning.

Real failures still emit `*:failed` and rethrow. **Telemetry never swallows.** An event
is emitted and the error continues propagating; observability is never the reason
something was handled.

## Fire-and-forget, durably

`kernel.emit()` returns `void`. A cognet never awaits its own telemetry, and a slow
observer can never apply backpressure to thinking.

The machine treats it more seriously than that. Events are committed to the session log's
telemetry view — alongside `kernel:*` — and the commit pipeline forwards them to the
runtime bus. At some level a cognet's events have to reach a log for the brain to be
debuggable, and this is that level.

Two consequences worth knowing:

**Telemetry is durable, not ephemeral.** You can replay a wake from the log and get the
same trace, including from a process that has since died.

**A fast cognet is chatty.** A continuous cognet ticking at 125Hz emits at least three
world-clock events per tick before it does anything of its own. That is a known cost of
the current design. If it bites, the gate belongs at the write path, not in cognet code
that stops naming its phases.

## What is not yours

`kernel.emit()` accepts `cognet:*` and nothing else. A call naming anything outside that
prefix throws — not a type error you can cast around, a refusal at the seam:

```ts
kernel.emit("kernel:run:complete", { /* ... */ })  // throws COGNET_EMIT_FORBIDDEN
```

The durable record around a wake — engine calls, capsule runs, their results — is the
kernel's and only the kernel's. A cognet that could write those could claim to have run
code it never ran.

This is the same boundary as everywhere else in the contract, applied to the trace:
[the cognet emits, the kernel records](/docs/v2/cognets/engine/kernel-contract).

## Naming as instrumentation

The practical consequence for authoring: **the names you choose are the trace you get.**

```ts
await phase("sense", async () => { /* ... */ })
await phase("render", async () => { /* ... */ })
await phase("invoke", async () => { /* ... */ })
await phase("act", async () => { /* ... */ })
```

Those four names are `zero`'s entire cognitive cycle, and they're also its trace. Reading
a session's telemetry tells you exactly how the brain spent its time, which phase a
failure happened in, and which tick a decision was made on.

A cognet that does all its work in one unnamed block runs identically and tells you
nothing. Naming stages is not documentation — it is the observability.
