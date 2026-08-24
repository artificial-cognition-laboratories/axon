---
title: Memory
description: The log-shaped mind — why cold boot and a steady-state tick are the same operation.
---

# Memory

A cognet has two kinds of memory, and the interesting one is not the persistent one.

**Module scope is the brain's RAM.** Anything `src/main.ts` and its imports hold in
closure survives across wakes for as long as the process lives. It is fast, ordinary
TypeScript, and completely undurable.

**The session log is the record.** Every stimulus the cognet received, every output it
emitted, every action it ran and every result that came back — all of it, in commit
order, owned by the kernel.

The relationship between those two is the whole design: **resident memory is a
projection of the log, and nothing else.** Lose it and you lose nothing. Rebuild it by
replaying. A mind shaped this way cannot drift from its own history, because its history
is the only thing it's made of.

## The read side

The cognet's access to the log is read-only and deliberately narrow:

```ts
kernel.store.session.get({ after: seq })  // entries newer than seq, in order
```

Synchronous — this is the kernel's live in-memory projection, not a disk read. It returns
entries only: the same envelopes stimuli arrive as. Kernel telemetry, error machinery,
and internal spans are not merely filtered out, they are unreachable — the store reads a
projection that was already classified by type namespace before the cognet ever asked.

A cognet cannot write to this log. It emits with `kernel.output()` or requests with
`kernel.run()`, and the kernel commits on its behalf. There is no `commit` verb in the
ABI and no way to synthesize one.

## One function

This is the entire memory system of `zero`, the reference cognet:

```ts
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

Read it twice, because the important property isn't obvious the first time.

On a **cold boot**, `state.seq` is `-1`, so `sync()` folds the entire history into
memory. On a **steady-state tick**, `state.seq` is the high-water mark from the last
tick, so `sync()` folds only what arrived since.

Those are the same call. Hydration and iteration are not two code paths that must be kept
in agreement — they are one operation with a different cursor. There is no separate
"restore from disk" routine to drift out of sync with the live one, because there is no
separate routine.

The cursor also makes it idempotent. Calling `sync()` twice folds nothing the second
time.

## Why the model is the log

`zero` holds its context as `AxonEntry[]` — the log, folded into memory, and nothing
more. That looks lazy. It is the opposite.

A model shaped like the log is:

**Trivially rebuildable.** Cold boot is `sync()` from `-1`. No snapshot format, no
migration, no version skew between what was persisted and what the code now expects.

**Trivially verifiable.** The resident model must equal `store.session.get()`. That's an
assertion you can actually write, and a class of bug that stops existing.

**Free of its own schema.** There's no second representation to design, document, or
keep in agreement with the first. The log is already the interchange format for the
entire platform — every observer, the TUI, the event pipeline, and replay all read the
same entries.

Derived structure — summaries, indexes, embeddings, a spatial map — earns its place the
day the cognet actually needs it, not before. When it does, it's still a projection: it
rebuilds from the same replay, and losing it costs a re-fold.

## Why `stimuli` goes unused

Every wake hands the loop body a `stimuli` diff. `zero` ignores it:

```ts
loop(async ({ signal, stop }) => {
    await phase("sync", async () => {
        sync()
    })
    // ...
})
```

Not an oversight. For a log-derived mind, **the log tail is the diff.** Stimuli arrive in
the log. So do the cognet's own outputs. So do action results the kernel committed on its
behalf. One door, one fold, one ordering — and the results of last tick's `run()` re-enter
the model by exactly the same path a user message does.

A cognet that folded `stimuli` separately would have two ingestion paths to keep
consistent. `zero` has one.

## `kill -9` costs nothing

This is the property everything above was built to produce.

Kill the process at any moment. Resident memory vanishes — the folded entries, the
cursor, every intermediate the brain was holding. Restart it. `sync()` runs from `-1`,
the model reconstitutes from the durable record, and the cognet resumes.

Nothing was authoritative in RAM, so nothing authoritative was lost. There is no
shutdown hook that must run, no flush that must complete, no window during which a crash
corrupts state. Durability isn't something the cognet participates in; it's a property of
the log, which the cognet cannot write to anyway.

For a long-running agent this is convenient. For an embodied system that can lose power
mid-decision, it's the difference between a design that works and one that doesn't.

## The private store

Some cognitive state genuinely isn't log-derived — a learned weight, a consolidated
summary, a cache that costs real time to rebuild. For that there's a private key/value
store, namespaced per cognet:

```ts
await kernel.store.set("checkpoint", { seq: state.seq, savedAt: Date.now() })
const checkpoint = await kernel.store.get("checkpoint")  // null when absent
```

Type it by declaration merging:

```ts
declare global {
    interface CognetStoreSchema {
        checkpoint: { seq: number; savedAt: number }
    }
}
```

Writes are atomic and resolve when durable. Reads return `null` when absent **or
unreadable** — cache doctrine: rebuild, don't crash. That's a deliberate contract. If
losing a key can break your cognet, it belonged in the log.

The kernel owns the mechanism entirely. Files today, something else tomorrow, invisible
to the cognet either way — the contract is `get`/`set`, not paths.

`zero` uses it for exactly one thing: a cursor checkpoint that proves the wiring works.
It is never load-bearing. Delete it and the cost is one full re-fold.

## The rule

> Anything that cannot be rebuilt from the log is state you are choosing to be
> responsible for.

Resident memory: free to lose. The log: the kernel's problem, not yours. The private
store: yours, and it should stay small enough that losing it is an inconvenience rather
than an outage.

Most cognets need nothing beyond the first two.
