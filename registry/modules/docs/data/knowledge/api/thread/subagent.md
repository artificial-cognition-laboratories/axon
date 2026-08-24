---
title: Subagent entries
---

# Subagent entries

Emitted when a capsule command calls `subagent.request()` or `subagent.stream()`.
All four entries share an `id` and `commandId` that link them to each other and to
the parent `capsule:stdin` entry.

## subagent:start

```ts
type SubagentStart = ThreadEntry<"subagent:start", {
    id: string         // stable ID linking start → complete/error for this invocation
    commandId: string  // parent capsule:stdin that triggered this sub-agent
    prompt: string
    mode: "request" | "stream"
}>
```

## subagent:entry

A single thread entry produced by the sub-agent while it is running.
Only emitted during `subagent.stream()` calls — one `subagent:entry` per inner entry.

```ts
type SubagentEntry = ThreadEntry<"subagent:entry", {
    id: string
    commandId: string
    entry: AnyThreadEntry  // the inner entry from the sub-agent
}>
```

## subagent:complete

```ts
type SubagentComplete = ThreadEntry<"subagent:complete", {
    id: string
    commandId: string
    text?: string       // final agent message — request mode only; empty for stream mode
    durationMs: number
}>
```

## subagent:error

```ts
type SubagentError = ThreadEntry<"subagent:error", {
    id: string
    commandId: string
    error: string
}>
```
