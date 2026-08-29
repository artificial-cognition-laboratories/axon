---
title: Anatomy of zero
description: The reference cognet, read in full.
---

# Anatomy of zero

`@axon/zero` is the default cognet — the brain every agent runs unless it selects another.
It is about 120 lines, and it is the thing you clone when you want to build your own.

```bash
axon clone @axon/zero
```

This page reads all of it.

## What it is

A conversational agent loop: fold the log, render context, call one engine, decide per
block what becomes real, repeat until the model says it's done and nothing is pending.

Three files.

```bash
zero/
├── plugins/
│   └── setup.ts      # boot hydration, shutdown checkpoint
├── src/
│   ├── main.ts       # the loop
│   └── state.ts      # the resident model
└── cognet.config.ts  # what it declares (optional)
```

## Identity

```ts
export default defineCognet({

    mode: { kind: "invocation" },

    // runaway guard: a wake that hasn't converged in this many
    // render→infer→act ticks is a loop bug or a stuck model, not progress
    maxTicksPerWake: 32,
})
```

Invocation mode: it sleeps until a stimulus arrives. `maxTicksPerWake: 32` is a safety
net — in practice zero converges in two or three.

## The resident model

```ts
export type ZeroState = {
    entries: AxonEntry[]
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

The model is the log, folded into memory, and nothing else.

That's the decision the rest of the cognet rests on. Cold boot is `sync()` with the cursor
at `-1`; a steady-state tick is `sync()` with the cursor at the high-water mark. Same
call, different cursor — so there is no separate hydration path that could drift from the
live one. See [Memory](/docs/v2/cognets/engine/memory).

## The loop

### sense

```ts
loop(async ({ signal, stop }) => {
    await phase("sync", async () => {
        sync()
    })
```

One fold, at the top of every tick.

On the first tick of a wake this pulls the triggering stimuli. On later ticks it pulls the
`cognet:action:typescript` and `cognet:action:result` entries the kernel committed for
last tick's `run()` — which is how tool results re-enter the model.

Note what the loop body signature *doesn't* use: `stimuli`. For a log-derived mind the log
tail is the diff, so stimuli, the cognet's own outputs, and action results all arrive
through this one door in one ordering.

### render

```ts
    const messages = await phase("render", async () => {
        return air.render({
            base: await kernel.base(),
            scope: kernel.scope(),
            history: state.entries,
        })
    })
```

Context is assembled from three things: the agent's identity (`base()`), the executable
tool surface (`scope()`), and zero's own resident history.

The kernel supplies the first two as raw material and has no opinion about where they land
in the rendered context. That placement is zero's decision, and a different cognet would
make it differently — or use a different format entirely. The AIR grammar zero uses is
zero's choice, not the platform's.

### invoke

```ts
    const { blocks, done } = await phase("invoke", async () => {
        const collected: string[] = []
        let stopped = false
        let speaking: string | null = null

        for await (const event of kernel.stream({ messages, signal })) {
            switch (event.type) {
                case "engine:text:delta":
                    if (!speaking) speaking = crypto.randomUUID()
                    await kernel.output("cognet:output:text", {
                        content: event.content,
                        chunk: { of: speaking },
                    })
                    break

                case "engine:text":
                    if (speaking) {
                        await kernel.output("cognet:output:text", {
                            content: "",
                            chunk: { of: speaking, final: true },
                        })
                        speaking = null
                    } else {
                        await kernel.output("cognet:output:text", { content: event.content })
                    }
                    break

                case "engine:typescript":
                    collected.push(event.content)
                    break

                case "engine:output:error":
                    await kernel.output("cognet:output:text", {
                        content: `[format] ${event.code}: ${event.message}`,
                    })
                    break

                case "engine:stop":
                    stopped = true
                    break
            }
        }

        return { blocks: collected, done: stopped }
    })
```

This is the part worth reading closely, because it's where the ABI's design shows.

The kernel yields **raw engine events**. It does not pre-label them as the cognet's
output. When a text block arrives, zero decides to emit it. When a typescript block
arrives, zero decides to collect it. That decision belongs to the cognet alone, and a
cognet that wanted to critique its own code before running it would simply not push to
`collected` here.

**Streaming is chunked emission.** Deltas emit as chunks of one correlation group; the
closing `engine:text` closes it with `final: true`. There is no separate push channel —
chunks are ordinary committed entries, so they reach every observer through the same
pipeline as any other fact.

**Code is collected, not run mid-stream.** Blocks accumulate until the model has finished
the whole message, so they run concurrently and an abort can't leave half a message acted
on.

**A format violation becomes an ordinary fact.** When the model breaks the AIR contract,
zero emits the error as text rather than throwing. Next tick's render shows the model its
own violation and it self-corrects.

**Stopping is causal, never inferred.** `engine:stop` is the model's explicit `<done/>`.
Zero never guesses that a response looked final.

### act

```ts
    if (blocks.length > 0) {
        await phase("act", async () => {
            await kernel.run(blocks, { signal })
        })
    }
```

An array runs every block concurrently and returns results in order.

Zero doesn't inspect those results. It doesn't need to: `kernel.run()` commits
`cognet:action:typescript` and `cognet:action:result` itself, so success and failure both
flow back through the log identically and arrive in the model at next tick's `sync()`.
That tick's render shows the model its own stdout.

### yield

```ts
    if (done && blocks.length === 0) stop()
})
```

Four lines that carry the cognet's judgment about its own completion.

`done` alone isn't enough. If the model emitted code this tick, there will be another
tick regardless of what it said — because the model must *witness its own results* before
the wake can honestly end. A cognet that stopped on `<done/>` while a tool call was still
unwitnessed would strand the result in the log, unseen.

## Lifecycle

```ts
export default definePlugin(({ hooks }) => {
    hooks.on("boot", async () => {
        sync()

        const checkpoint = await kernel.store.get("checkpoint")
        kernel.emit("cognet:log:info", {
            value: checkpoint
                ? `zero: hydrated ${state.entries.length} entries (checkpoint seq ${checkpoint.seq}, live seq ${state.seq})`
                : `zero: cold boot, hydrated ${state.entries.length} entries`,
        })
    })

    hooks.on("shutdown", async () => {
        await kernel.store.set("checkpoint", { seq: state.seq, savedAt: Date.now() })
    })
})
```

`boot` calls the same `sync()` the loop calls. Rehydration isn't a special path.

`shutdown` persists a cursor and nothing else. Durable episodic writes already happened
through the kernel at the moment they mattered, so the only thing in RAM worth saving is
the high-water mark — and even that is an optimization. Delete the checkpoint and zero
cold-boots with one full re-fold, losing nothing.

## What zero doesn't do

Reading a reference implementation for its absences is often more useful than reading it
for its features.

**It holds no entities.** The ECS world is constructed for every wake, and zero uses it
purely for `phase()` timing. Its model is the folded log. That's a legitimate way to use
the engine — the world is available, not mandatory.

**It never inspects run results.** Success and failure take the same path back into the
model.

**It has no retry logic, no summarization, no compression.** Not because those are wrong,
but because zero is the reference, and every one of them is a strategy decision that
belongs to whoever needs it.

**It ignores `stimuli`.** The log tail is the diff.

## Where to change it

The four phases are the natural seams:

| Phase | Change it to |
|---|---|
| `sync` | hold a derived model — a summary, an index, a spatial map |
| `render` | use a different grammar, a different context budget, a different format entirely |
| `invoke` | call several engines, critique before running, route by block type |
| `act` | gate execution, ask for confirmation, transform blocks first |

None of that touches the kernel. The contract stays exactly ten verbs, whichever of
these you rewrite.
