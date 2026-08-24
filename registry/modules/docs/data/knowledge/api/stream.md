---
title: axon.stream
---

# axon.stream

Invokes the agent loop and yields entries as they arrive. Returns `{ stream }` — an
async generator of `AnyThreadEntry` values.

```ts
const { stream } = axon.stream("scout the repository and report findings")

for await (const entry of stream) {
    if (entry.type === "text") process.stdout.write(entry.content)
}
```

With options:

```ts
const context = await axon.prompt("context")
const scout   = await axon.prompt("scout")

const { stream } = axon.stream({
    prompt: [context, scout],   // array — Axon concatenates in order
    policy: { ... },            // narrow the active policy for this call only
})

for await (const entry of stream) { ... }
```

Use `stream` when forwarding output incrementally — chat routes, long-running tasks,
progress display. The loop may run for seconds or minutes; streaming lets you show
work in real time rather than blocking until done.

## Entry types

The entries you most commonly act on while iterating:

```ts
entry.type === "axon:agent:message:delta"   // streaming chunk — payload.content
entry.type === "axon:agent:message"         // final accumulated message — payload.content
entry.type === "capsule:stdout"             // tool process output — payload.data
entry.type === "pathway:complete"           // loop finished — payload.durationMs, billing
```

Deltas arrive in real time as the model generates. The final `axon:agent:message`
entry carries the fully accumulated content — renderers typically accumulate deltas
in place and replace with the final entry on completion.

## Forwarding from a route

The standard pattern for a streaming chat route:

```ts
// server/api/chat.ts
export default defineEventHandler(async (event) => {
    const { message } = await readBody(event)
    const { stream } = axon.stream(message)
    return sendStream(event, stream)
})
```

See [axon.request](/docs/v2/api/request) for the non-streaming equivalent.
