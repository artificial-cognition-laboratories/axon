---
title: Pathway entries
---

# Pathway entries

One pathway invocation wraps each call to `axon.request()` or `axon.stream()`.
All pathway entries share an `invocationId` that links them together.

## pathway:start

Emitted before the pathway handler runs.

```ts
type PathwayStart = ThreadEntry<"pathway:start", {
    pathway: string       // route name e.g. "api/chat"
    invocationId: string  // stable ID linking all events from this invocation
}>
```

## pathway:complete

Emitted after the handler returns successfully.

```ts
type PathwayComplete = ThreadEntry<"pathway:complete", {
    pathway: string
    invocationId: string
    durationMs: number
    billing: BillingTotal | null  // null if no engine was called
}>
```

## pathway:abort

Emitted when the client cancels the request (e.g. user presses Escape).

```ts
type PathwayAbort = ThreadEntry<"pathway:abort", {
    pathway: string
    invocationId: string
    reason?: string
}>
```

## pathway:error

Emitted when the pathway handler throws an unhandled error.

```ts
type PathwayError = ThreadEntry<"pathway:error", {
    pathway: string
    invocationId: string
    error: string
}>
```

## engine:retry

Emitted each time an LLM call fails with a transient error and is being retried.
A final `axon:agent:error` with kind `"engine:error"` follows if all attempts are exhausted.

```ts
type EngineRetry = ThreadEntry<"engine:retry", {
    engine: string       // which engine is retrying
    attempt: number      // 1-based retry index
    maxAttempts: number
    status?: number      // HTTP status that triggered the retry
    delayMs: number      // wait before next attempt
}>
```
