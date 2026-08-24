---
title: src/state.ts
description: The resident model — module scope as the brain's RAM.
---

# src/state.ts

There is no required file here. `state.ts` is a convention, not a contract: the engine
never reads it, and a cognet that keeps everything in `main.ts` is perfectly valid.

The convention exists because resident memory is worth isolating. `main.ts` is the
pipeline; `state.ts` is what the pipeline operates on, shared by plain import with
whatever else needs it.

```ts
import type { AxonEntry } from "@arcforge/types"

export type ZeroState = {
    /** the folded episodic log, in seq order — what render() sees */
    entries: AxonEntry[]
    /** high-water mark: the last seq folded. -1 = nothing yet. */
    seq: number
}

export const state: ZeroState = {
    entries: [],
    seq: -1,
}

export function sync(): void {
    for (const entry of kernel.store.session.get({ after: state.seq })) {
        state.entries.push(entry)
        state.seq = entry.time.seq
    }
}
```

That's `zero`'s entire memory system.

## One copy per brain

The compile step bundles `main.ts`, `plugins/`, and everything they import into a single
artifact. So a plain `import { state } from "./state"` from two places gives you the same
object — module scope is the sharing mechanism, and there is exactly one copy per brain.

```ts
// main.ts
import { state, sync } from "./state"

// plugins/setup.ts
import { state } from "./state"
```

No registry, no injection, no singleton ceremony. Ordinary module semantics.

## Shape it however you like

`zero` holds the folded log and nothing else. That's a deliberate reference pattern — see
[Memory](/docs/v2/cognets/engine/memory) for why a log-shaped model is trivially
rebuildable and verifiable — but it is not the only shape.

A perception cognet might hold a spatial index. A planner might hold a task tree. A
controller might hold three floats:

```ts
export const state = {
    integral: 0,
    previous: 0,
    lastCommand: 0,
}
```

The engine has no opinion. It never reads your state, never serializes it, and never
restores it.

## The one rule

> **Nothing here is authoritative.**

Resident memory must be reconstructible from the durable record. If losing this object on
a restart would lose information the cognet needs, it belonged in the session log or in
`kernel.store` — not here.

That constraint is what makes `kill -9` free. Kill the process at any point, restart, and
the brain rebuilds from the log with nothing missing. There is no shutdown hook that must
run and no flush that must complete, because nothing in RAM was the source of truth.

Get this wrong and you've built a mind that can only survive a graceful shutdown. For a
long-running agent that's an inconvenience. For an embodied system that can lose power
mid-decision, it's a design failure.

## Typing the private store

If your cognet uses `kernel.store`, declare its schema here by declaration merging:

```ts
declare global {
    interface CognetStoreSchema {
        checkpoint: { seq: number; savedAt: number }
    }
}
```

`kernel.store.get("checkpoint")` is then typed, and a key you never declared is a compile
error rather than a runtime surprise.

Keep what goes in there small. Reads return `null` when absent **or unreadable** — cache
doctrine: rebuild, don't crash. If losing a key can break your cognet, it belonged in the
log.
