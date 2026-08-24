---
title: Thread entry
---

# Thread entry

Every value emitted by `axon.stream()` or stored in `result.entries` is a `ThreadEntry`.

```ts
type ThreadEntry<TKind extends string, TPayload> = {
    id: string           // stable unique ID — deltas share the ID of their final entry
    time: EventTime      // monotonic sequence within the thread
    threadId: string     // which thread this entry belongs to
    type: TKind          // discriminant — use to narrow the union
    payload: TPayload
    billing?: BillingSnapshot  // present only on entries that consumed LLM tokens
}
```

## EventTime

```ts
type EventTime = {
    ms: number   // wall-clock milliseconds (Unix epoch)
    seq: number  // monotonic counter — resolves ordering within the same ms
}
```

## BillingSnapshot

Attached to any entry that made an LLM call.

```ts
type BillingSnapshot = {
    provider: string
    model: string
    tokens: { in: number; out: number; total: number }
    cost:   { in: number; out: number; total: number }  // USD
    durationMs: number
}
```

## BillingTotal

Accumulated across all LLM calls — appears in `thread:end` and `pathway:complete`.

```ts
type BillingTotal = {
    tokens: { in: number; out: number; total: number }
    cost:   { in: number; out: number; total: number }
    calls: number
}
```

## thread:start

First entry on every thread. Emitted automatically by the runtime.

```ts
type ThreadStart = ThreadEntry<"thread:start", {
    schemaVersion: 1
    agentId: string
    agentName?: string
    agentVersion?: string
    clientId: string
    threadName?: string         // "__exec__" | "__script__:{name}:{uuid}" | user-supplied name
    capsuleSessionId?: string   // links to capsule-side events when a capsule is attached
    authenticated: boolean
    context?: Record<string, unknown>
}>
```

## thread:end

Last entry on every thread. Emitted automatically by the runtime.

```ts
type ThreadEnd = ThreadEntry<"thread:end", {
    reason: "client:disconnect" | "axon:agent:shutdown" | "error" | "timeout"
    billing: BillingTotal
}>
```
