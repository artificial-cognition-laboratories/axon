---
title: The Loop
description: loop, tick, phase, system, stop — and the world clock they drive.
---

# The Loop

A cognet declares exactly one loop. It is the brain's entry point and the only thing the
kernel calls.

```ts
loop(async ({ stimuli, signal, stop }) => {
    await phase("sense", async () => { /* fold what's new */ })
    await phase("think", async () => { /* decide */ })
    await phase("act",   async () => { /* emit or run */ })

    stop()
})
```

`src/main.ts` is a raw script, not a module with exports. It runs once at load with the
ambient globals live, and its job is to declare `loop()`. Everything it holds in module
or closure scope is the brain's resident memory for the life of the process.

Declaring two loops is an error. So is declaring none.

## Wake, tick, stop

A **wake** is one invocation of the brain. The kernel schedules it; the cognet cannot.

A **tick** is one iteration of the loop body inside that wake. The body runs repeatedly
until it calls `stop()` or the wake is aborted.

```ts
loop(async ({ stop }) => {
    // ... this runs again, and again, until:
    stop()   // end the wake after this tick completes
})
```

`stop()` is a declaration that the wake is finished, not an immediate exit — the current
tick runs to completion. The brain stays warm afterward: module scope survives, and the
next wake starts with everything still resident.

The distinction matters because it's where a cognet expresses *judgment about its own
completion*. `zero` will not stop while it still has unwitnessed results:

```ts
// Code this tick means another tick regardless of what the model said —
// the model must see its own results before the wake can honestly end.
if (done && blocks.length === 0) stop()
```

That policy belongs to the cognet. The kernel has no opinion about when thinking is
finished.

### The runaway guard

```ts
export default defineCognet({
    maxTicksPerWake: 32,
})
```

A wake that hasn't converged in this many ticks is a loop bug or a stuck model, not
progress. The host throws rather than spinning. It's a safety net, not a scheduling
mechanism.

## The world clock

`tick`, `phase`, and `system` are the **only writers of the world clock**. Nothing else
in the system advances it.

Each one brackets its callback with telemetry — start, complete, failed, interrupted — so
the shape of a thought is recorded as it happens rather than reconstructed afterward.

### `phase` — a named stage

```ts
const messages = await phase("render", async () => {
    return air.render({ base: await kernel.base(), scope: kernel.scope(), history: state.entries })
})
```

Sets `state.phase` for its duration and returns whatever the callback returns. Use it for
the major stages of a tick — the ones you'd name if you were describing how the brain
thinks.

`zero` uses four: `sync`, `render`, `invoke`, `act`.

### `system` — a unit of work

```ts
await system("embed-query", async () => { /* ... */ })
```

Timed, and stamped with the current tick and phase. Use it for work inside a phase you
want to measure separately.

The naming is borrowed from ECS deliberately: a system is a unit of work that runs against
the world. See [The World](/docs/v2/cognets/engine/world).

### `tick` — driven for you

The host wraps each iteration of your loop body in a tick. You don't call it; you observe
it in the telemetry and in `maxTicksPerWake`.

## Interrupt is a third outcome

When a wake is aborted — the user pressed Escape, the process is shutting down — whatever
the in-flight `phase()` threw is *cancellation surfacing through the call stack*, not a
failure of that phase's work.

The loop wrappers check the wake's `signal` before classifying:

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

Interrupted and failed are different events. A cancelled thought is not a broken one, and
your telemetry shouldn't claim otherwise.

Real failures still emit `*:failed` and rethrow. Telemetry never swallows.

## The wake argument

```ts
loop(async ({ stimuli, signal, stop }) => { /* ... */ })
```

**`stimuli`** — the entries that arrived since the last wake. An empty diff is the
ordinary steady state, not an edge case to special-case.

`zero` ignores this argument entirely. For a log-derived mind the log tail *is* the diff,
so folding `store.session.get({ after: seq })` covers stimuli, its own outputs, and action
results through one door. See [Memory](/docs/v2/cognets/engine/memory).

**`signal`** — the wake's abort leash. Forward it to every long operation:

```ts
for await (const event of kernel.stream({ messages, signal })) { /* ... */ }
await kernel.run(blocks, { signal })
```

A cognet that doesn't forward `signal` can't be interrupted, and the kernel cannot force
it. This is the one piece of cooperative behaviour the contract asks for.

**`stop`** — end the wake after this tick.

## Invocation and continuous

A cognet declares how it is triggered:

```ts
export default defineCognet({
    mode: { kind: "invocation" },
})
```

**Invocation** — the brain wakes when a stimulus arrives. This is what ships today, and
what every conversational agent uses.

**Continuous** — the brain wakes on a clock, whether or not anything arrived. This is the
mode a control loop or perception stack needs.

```ts
export default defineCognet({
    mode: { kind: "continuous" },
})
```

The declaration carries no rate, because **the brain owns its own rhythm**. A cognet that
declared `tickMs` would be asserting how fast its world turns, which it cannot know. A
body that drove the wake would be asserting how often a mind should think, which it cannot
know either — and it would break the swap test, since a body wired to one brain has to be
rewritten to carry another. The brain's own plugin drives each wake:

```ts
// plugins/clock.ts — in the COGNET
export default definePlugin(({ hooks }) => {
    hooks.on("boot", () => {
        setInterval(() => void kernel.wake(), 33)
    })
})
```

The body, meanwhile, only ever senses — it never wakes anything:

```ts
// server/plugins/body.ts — in the AGENT
setInterval(async () => {
    world.step(dt)
    await axon.stim("cognet:stimulus:field", { ... })
}, 16)
```

`kernel.wake()` hands the cognet whatever is on the stimulus buffer and wakes it. **Every
wake starts** — it never waits for, and never skips because of, one still running. It
resolves on admission rather than completion, so a driver that awaits it never serialises
the overlap.

That is the whole reason a mind can think and sense at once. A stimulus is delivered once
and then dropped, so a skipped tick is not a late tick: it is a tick that never heard, and
the frames it would have carried are gone. Queueing is worse — two seconds of backlog
arrives at one tick, that tick runs long, and the backlog compounds. A brain that goes
deaf while forming a sentence cannot be interrupted, which rules out every conversational
workload.

So wakes overlap, and they share the cognet's module scope, exactly as a brain's regions
share one body:

```ts
loop(async ({ stimuli, stop }) => {
    fold(stimuli)                       // fast: every tick, always cheap

    if (ready() && !state.thinking) {   // slow: kicked off, never awaited
        state.thinking = true
        void deliberate().finally(() => { state.thinking = false })
    }

    stop()
})
```

Coordinating that — not calling the engine twice, dropping work that arrived while busy —
is the cognet author's, through their own resident state. The kernel supplies no primitive
for it, because any primitive would be the runtime having an opinion about how cognition
should be organised.

An **invocation** cognet is different: it is one conversation, so a second concurrent
invoke is a caller error and throws `RUN_IN_PROGRESS`.

The log stays coherent under overlap — one writer, `seq` is still a total order. What
changes is that spans from different wakes interleave, so the flame graph rebuilds nesting
per `runId` rather than globally.

Both modes call the same wake machinery. Neither trigger source knows the other exists.

## Plugins

Lifecycle hooks live in `plugins/`, separate from the loop:

```ts
export default definePlugin(({ hooks }) => {
    hooks.on("boot", async () => { /* once, after load */ })
    hooks.on("wake", async wake => { /* each wake, before the first tick */ })
    hooks.on("tick", async ({ tick }) => { /* each tick — keep this cheap */ })
    hooks.on("shutdown", async () => { /* once, at unload */ })
})
```

Four fixed points, awaited to completion in order. `boot` is where a cold-start
rehydration belongs; `tick` is on the hot path and should stay light.

Plugins register at import time, before `load()` fires — so a plugin's hooks are in place
before the brain's first breath.
