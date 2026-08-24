---
title: src/main.ts
description: The brain — a raw script that declares one loop.
---

# src/main.ts

This file **is** the brain.

Not a module exporting a factory, not a class implementing an interface. A raw script
that runs once at load, with the ambient globals live, and declares exactly one `loop()`.

```ts
import { render } from "./render"
import { state, sync } from "./state"

loop(async ({ signal, stop }) => {
    await phase("sync", async () => {
        sync()
    })

    const messages = await phase("render", async () => {
        return render({
            base: await kernel.base(),
            scope: kernel.scope(),
            history: state.entries,
        })
    })

    // ...
    stop()
})
```

Ordinary imports work. Module scope works. The only rule is that the script declares one
loop, and does it by the time it finishes running.

## Why a script, not a module

The authoring surface is two clutter-free files, and this is the one with the thinking in
it. There's no `defineCognet({ load, wake, unload })` boilerplate to write because the
compile step generates it:

1. It **wraps** this file — hoisting the imports out, deferring the body into a callable.
2. It **generates an entry** that imports the host *first*, so the ambient globals are
   installed before your code evaluates.
3. It **composes** host + config + main into the definition the kernel loads.

The desugared form is an ordinary definition against the ABI. There is no side channel.

## Module scope is resident RAM

Everything this file holds in module or closure scope lives for the life of the process:
alive across wakes, rebuildable from the log, and gone without loss on `kill -9`.

```ts
import { state } from "./state"   // the resident model

const encoder = buildEncoder()    // constructed once, reused every wake
```

Anything expensive to build belongs at the top level, not inside the loop. It's
constructed once and every wake uses it.

The rule that makes this safe: **nothing up here is authoritative.** If losing it on a
restart would lose information, it belonged in the log. See
[Memory](/docs/v2/cognets/engine/memory).

## Do work inside the loop

The kernel binds at `load()`, and this script runs *during* load. So the globals exist,
but reaching for kernel state at module top level is a mistake:

```ts
// wrong — runs during load, before any wake exists
const scope = kernel.scope()

loop(async ({ stop }) => {
    // right — runs inside a wake
    const scope = kernel.scope()
    stop()
})
```

Syscalls that need a running wake throw `SYSCALL_OUTSIDE_RUN` when called outside one.
Construct your own objects at the top level; ask the kernel things inside the loop.

## The ambient globals

Typed by `.cognet/globals.d.ts`, which `axon prepare` regenerates:

| Global | What it is |
|---|---|
| `loop(body)` | Declare the tick pipeline. Exactly once. |
| `kernel` | The syscall table — the ten verbs. |
| `phase(name, fn)` | A named stage within a tick. |
| `system(name, fn)` | A timed unit of work within a phase. |

Wake-scoped things are **not** globals. They arrive as arguments to the loop body:

```ts
loop(async ({ stimuli, signal, stop }) => { /* ... */ })
```

That split is deliberate. Process-lifetime things are ambient; anything belonging to one
wake is passed in, so it can never leak into the next one.

## One loop, declared once

```ts
loop(async ({ stop }) => { /* ... */ })
loop(async ({ stop }) => { /* ... */ })   // throws COGNET_LOOP_ALREADY_DECLARED
```

Running `main()` without declaring a loop throws too. A brain with no loop and a brain
with two are both incoherent, and both fail at load rather than at the first wake.

## Structure it however you like

The loop body is yours. `zero` uses four phases in a fixed order, but nothing enforces
that shape:

```ts
loop(async ({ stop }) => {
    await phase("sense", async () => { /* ... */ })
    await phase("think", async () => { /* ... */ })
    await phase("act", async () => { /* ... */ })
    stop()
})
```

Branch, loop, call other functions, split across files. Phases are how you name and time
the stages — not a pipeline the engine imposes. See
[The Loop](/docs/v2/cognets/engine/loop).
