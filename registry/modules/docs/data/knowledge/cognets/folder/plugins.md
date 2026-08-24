---
title: plugins
description: Lifecycle hooks — boot, wake, tick, shutdown. Plumbing only.
---

# plugins

Four fixed lifecycle points, wired to non-cognitive work: hydrating the resident model,
warming a cache, checkpointing on the way out.

```ts
export default definePlugin(({ hooks }) => {
    hooks.on("boot", async () => { /* once, after load, before the first wake */ })
    hooks.on("wake", async wake => { /* each wake, before the first tick */ })
    hooks.on("tick", async ({ tick }) => { /* each tick — keep this cheap */ })
    hooks.on("shutdown", async () => { /* once, at unload */ })
})
```

Files in `plugins/` are imported by the compile step *after* the host installs the
globals, so a plugin's `hooks.on(...)` registrations land before `load()` fires `boot`.
Hooks are awaited to completion, in registration order.

## The rule

> **Plumbing only. Cognition never lives here.**

That line is worth taking literally. Domain facts are stimuli that fold into the model
through the ordinary path — they do not arrive through hooks. If a plugin is making
decisions, the decision belongs in the loop.

The distinction is what keeps `main.ts` honest as a description of how the brain thinks.
A reader who understands your loop should not be surprised by something a hook did.

## `boot` — hydrate

Fires once: brain assembled, kernel bound, loop declared, not yet woken. This is where a
cold start becomes a warm one.

```ts
hooks.on("boot", async () => {
    sync()   // fold the entire log into the resident model

    const checkpoint = await kernel.store.get("checkpoint")
    kernel.emit("cognet:log:info", {
        value: checkpoint
            ? `hydrated ${state.entries.length} entries (checkpoint seq ${checkpoint.seq})`
            : `cold boot, hydrated ${state.entries.length} entries`,
    })
})
```

Nothing is passed in. The cognet reads what it wants through `kernel.store.session.get()`
— for a log-derived mind, that call is the whole rehydration story.

Note that `sync()` here is the same function the loop calls every tick. Boot isn't a
special path; it's the ordinary fold with the cursor still at `-1`. See
[Memory](/docs/v2/cognets/engine/memory).

## `wake` — per episode

Fires at the start of every wake, before the first tick, and receives the wake context.
Use it for per-episode setup that isn't part of thinking — resetting a scratch buffer,
starting a timer.

Most cognets don't need it.

## `tick` — the hot path

Fires before each iteration of the loop body.

```ts
hooks.on("tick", async ({ tick }) => { /* keep this cheap */ })
```

This runs inside the tick, awaited, so anything slow here is added to every tick's
latency. For a continuous cognet at 125Hz that cost lands 125 times a second. Treat it as
a hot path or leave it empty.

## `shutdown` — checkpoint

Fires once at unload.

```ts
hooks.on("shutdown", async () => {
    await kernel.store.set("checkpoint", { seq: state.seq, savedAt: Date.now() })
})
```

Note what `zero` does *not* do here: it doesn't flush the conversation, persist entries,
or save the model. Durable episodic writes already happened through the kernel at the
moment they mattered. The only thing worth persisting from RAM is a cursor — and even
that is an optimization, not memory.

**A cognet must never depend on `shutdown` running.** It won't on `kill -9`, and a design
that needs it is a design that can't survive power loss. If losing what this hook would
have saved is a problem, it belonged in the log.

## Multiple plugins

Every file in `plugins/` is loaded, and each can register any of the four hooks. Handlers
for the same hook run in registration order, awaited to completion.

```bash
plugins/
├── devtools.ts    # extra telemetry while developing
└── setup.ts       # boot hydration, shutdown checkpoint
```

Splitting by concern is fine. Just keep every one of them plumbing.
