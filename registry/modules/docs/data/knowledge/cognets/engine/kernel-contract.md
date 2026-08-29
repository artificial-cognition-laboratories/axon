---
title: The Kernel Contract
description: The ten verbs a cognet has, and everything it structurally cannot do.
---

# The Kernel Contract

A cognet is versioned against the kernel exactly like a binary is versioned against
syscalls. The kernel evolves freely underneath; the contract is this shape, and it is the
only thing a cognet ever holds.

Read this page before the others. Everything that follows is a consequence of it.

## The privilege inversion

Axon already treats model-authored code as untrusted. The capsule can request; only the
kernel can take.

Cognets extend the same inversion one ring further in. **The cognet is the cognition, and
the kernel protects the user's resources from it with equal severity.** Not because a
cognet is malicious — you wrote it — but because a boundary that only holds for
well-behaved code isn't a boundary.

| Ring | Component | Holds |
|---|---|---|
| 0 | kernel | engine, scheduler, the capsule constructor, the session log |
| 3 | cognet | ten verbs |
| 3 | capsule | model-authored code, policy-gated |

The cognet and the capsule are both unprivileged, for different reasons and through
different doors.

## The ten verbs

```ts
type KernelAbi = {
    output<K>(type: K, data: AxonOutputEvent[K]): Promise<void>
    stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineEvent>
    run(code: string,   opts?: { signal?: AbortSignal }): Promise<AxonRunResult>
    run(code: string[], opts?: { signal?: AbortSignal }): Promise<AxonRunResult[]>
    scope(): AxonScope
    base(): Promise<string>
    emit<K>(type: K, data: CognetEventMap[K]): void
    store: KernelStore
    wake(): Promise<number>
    clock(): KernelClock
    models: Readonly<Record<string, string>>
}
```

That's the whole surface. There is no eleventh verb and no escape hatch.

### `output` — unmediated emission

```ts
await kernel.output("cognet:output:text", { content: "done" })
```

The cognet already has the full content and nothing external can fail it, so this is
unmediated at the call site — writing to your own stdout can't itself harm anything. The
kernel commits it durably and forwards it live, but **never refuses it**.

Filtering or redaction, if a host wants it, happens downstream on the delivery path. It's
never a gate this call has to pass.

### `run` — mediated request

```ts
const result = await kernel.run(code, { signal })
const results = await kernel.run([blockA, blockB], { signal })   // concurrent
```

The cognet doesn't know the outcome until the capsule responds, so this is policy-gated.
It **never rejects**: success and failure are both ordinary values on the result.

```ts
type AxonRunResult = {
    ok: boolean
    value?: unknown
    stdout: string[]
    error?: { kind: "timeout" | "interrupt" | "exception"; message: string }
}
```

Timeout, abort, and exception collapse into one `error.kind` rather than three control
flows you'd have to catch and re-discriminate. An array of blocks runs concurrently and
returns results in order — the common "await several tool calls" case needs no manual
fan-out.

The kernel commits both `cognet:action:typescript` and `cognet:action:result` to the log
itself, the moment each block settles. The cognet reads the returned value for its own
control flow and writes nothing.

### `stream` — inference

```ts
for await (const event of kernel.stream({ messages, signal })) { /* ... */ }
```

The kernel mediates provider access — auth, metering, quotas. The cognet owns everything
about what the messages contain.

It yields raw `engine:*` wire events. The kernel does **not** pre-label them as the
cognet's output: when a text block arrives, it's the cognet that decides whether to
`output()` it; when a typescript block arrives, it's the cognet that decides whether to
`run()` it. That decision belongs to the cognet alone.

This is one verb of ten. A cognet that never calls it is still a cognet.

### `scope` — executable reality

```ts
const scope = kernel.scope()
```

The complete TypeScript surface implemented by the current capsule incarnation. The
kernel reports what's executable; the cognet decides whether and how that enters model
context.

### `base` — the user's identity contract

```ts
const identity = await kernel.base()   // "" when none declared, never undefined
```

The agent's rendered `boot.vue`. Kernel-mediated because it's the *user's* contract, not
cognet strategy: a swapped brain decides where the base context sits in its rendering,
never what it says.

### `emit` — narrate your own world

```ts
kernel.emit("cognet:phase:start", { tick, phase })
```

Fire-and-forget for the cognet, durable in the machine: committed to the log and
forwarded to the runtime bus as flame-graph material.

Restricted to `cognet:*` and enforced at the call site, not just in the types. A cognet
narrates its own world; it can never forge kernel machinery events.

### `store` — private state, read-only history

```ts
kernel.store.session.get({ after: seq })   // read-only, entries only, synchronous
await kernel.store.get("checkpoint")
await kernel.store.set("checkpoint", { seq, savedAt: Date.now() })
```

Covered in full in [Memory](/docs/v2/cognets/engine/memory).

### `wake` — the brain's own rhythm

```ts
// plugins/clock.ts
export default definePlugin(({ hooks }) => {
    hooks.on("boot", () => {
        setInterval(() => void kernel.wake(), 33)
    })
})
```

Continuous cognets only. The body emits stimuli and never decides when the brain looks at
them: how fast frames arrive is a property of a sensor, how often it is worth thinking
about them is a property of a mind.

Resolves with the wake's ordinal **as soon as it is admitted**, never when it completes —
a driver that awaited completion would serialise the overlap continuous mode exists to
allow. See [The Loop](/docs/v2/cognets/engine/loop).

### `clock` — a snapshot of that rhythm

```ts
const { wakes } = kernel.clock()
if (wakes % 4 === 0) { /* the slow path, every fourth wake */ }
```

Deliberately thin: wakes admitted since boot, and nothing else has earned a place yet.
Not the per-wake tick counter `phase()` telemetry stamps against — two different numbers
at two scales.

### `models` — where the declared weights landed

```ts
const session = await ort.InferenceSession.create(kernel.models.vad)
```

Absolute paths to the weights this cognet declared in `models:`, by the name it gave
them. Already fetched and verified; empty when none were declared.

Handed over at load rather than read from the cognet's own config, because a filesystem
path is **environmental**: the same brain gets a different absolute path on every machine
and must never learn that. The config says which weights are needed; this says where they
are.

Whether they came from a registry, a shared cache or a deployment image is invisible
here. The kernel guarantees the file exists and was verified, nothing more — what the
bytes MEAN is the cognet's business, and so is the runtime that reads them.

## What a cognet cannot do

The absences are the design. None of these are enforced by convention — there is no API
to call.

**No filesystem, no network, no shell.** Not restricted: absent. The only path to any of
them is asking the kernel to run code in a capsule the kernel alone constructs, under the
agent's policy.

**No writing to the log.** There is no `commit` verb. The cognet emits and requests; the
kernel writes on its behalf. A cognet cannot forge history, backdate a decision, or
record something it didn't do.

**No reading kernel telemetry.** `store.session.get()` returns entries only — the same
envelopes stimuli arrive as. Kernel spans and error machinery aren't filtered out, they're
unreachable: the store reads a projection already classified by type namespace before the
cognet asks.

**No configuration.** A cognet cannot read the agent's config, paths, deploy settings,
engine choice, or module list. It does not know what kind of world it is in — which is
precisely what makes it portable to a different one.

**No clock of its own.** Wakes are scheduled by the kernel. A cognet cannot decide to run.

**No thread or session concept.** There is no id to address anything by. One cognet
instance is exactly one continuous stream. Multiple conversations are multiple Axon
instances — a host concern this ABI has no opinion on.

**No identity.** A cognet has no name it can act on, no owner it can query, no
credentials. Identity belongs to the perimeter, not the mind inside it.

## What the kernel will not do

The boundary runs both ways. The kernel has **no opinion on cognition**.

No grammar. No context assembly. No prompt format. No loop strategy, no stop condition,
no compression, no memory policy. It guards the user's base identity and reports the
capsule's executable scope; the cognet alone decides how either enters model context.

The AIR format that `zero` uses is `zero`'s choice, not the platform's. Another cognet
can use a different grammar, or no grammar at all. Nothing above this line has an opinion.

## Wake scope

Process-lifetime things are ambient. Wake-scoped things arrive as arguments:

```ts
loop(async ({ stimuli, signal, stop }) => { /* ... */ })
```

- `stimuli` — what arrived since the last wake. An empty diff is ordinary, not an edge case.
- `signal` — the wake's abort leash. Forward it to `stream()` and `run()`.
- `stop()` — end the wake after this tick. The brain stays warm.

The ABI itself carries nothing per-wake. It's one process-lifetime object, and it is the
only thing a cognet ever holds.

There is deliberately no push or delta channel. A temporally-extended emission — streaming
speech, a progressive result — is expressed through `output()` itself using the chunking
standard: correlated entries, closed by a `final` marker. Chunks are ordinary committed
entries, so they reach every observer through the same commit pipeline as any other fact.

## Versioning

Every compiled cognet carries the ABI it targets. Normally it declares nothing: a cognet
publishes as source and is compiled by the consumer against the kernel it will actually
run on, so the compile step stamps in the ABI it built against.

A cognet that must **refuse** a kernel it hasn't been validated against pins it:

```ts
export default defineCognet({
    abi: "11",
    mode: { kind: "invocation" },
})
```

`axon prepare` verifies a pin against the kernel this Axon provides and fails loudly on a
mismatch, naming both versions. A cognet pinned to an older ABI never half-loads.

The kernel is free to change anything beneath this contract. The contract itself changes
only with the ABI number.
