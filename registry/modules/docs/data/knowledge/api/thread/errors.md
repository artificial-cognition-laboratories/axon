---
title: Error entries
---

# Error entries

## axon:agent:error

All runtime errors arrive as a single entry type. The `payload.kind` discriminant
identifies the specific failure.

```ts
type AgentError = ThreadEntry<"axon:agent:error", AnyAgentError>
```

## Error kinds

### engine:error

LLM engine call failed — upstream provider error (503, rate limit, auth, timeout).

```ts
{ kind: "engine:error"; message: string; code?: number; engine?: string }
```

### engine:not-found

`$engine()` was called with a name that has no registered engine. Always fatal.

```ts
{ kind: "engine:not-found"; message: string; engine: string; available: string[] }
```

### capsule:error

Capsule execution failed — runtime crash, timeout, or policy denial.

```ts
{ kind: "capsule:error"; message: string; commandId?: string }
```

### middleware:rejected

A pathway's middleware chain rejected the request before the handler ran.
The pathway did not execute.

```ts
{ kind: "middleware:rejected"; message: string; pathway: string; middleware?: string }
```

### pathway:not-found

The client requested a pathway that does not exist on this agent.

```ts
{ kind: "pathway:not-found"; message: string; pathway: string; available: string[] }
```

### pathway:error

An unhandled error escaped the pathway handler and was caught at the server boundary.

```ts
{ kind: "pathway:error"; message: string; pathway: string }
```

### script:error

Script execution failed — runtime error thrown during `axon.run`.

```ts
{ kind: "script:error"; message: string; script?: string }
```

### auth:error

Authentication failed or session expired.

```ts
{ kind: "auth:error"; message: string }
```

### rate:error

Client is being rate limited.

```ts
{ kind: "rate:error"; message: string; retryAfterMs?: number }
```

### balance:error

Insufficient Ψ balance to process the request.

```ts
{ kind: "balance:error"; message: string; topUpUrl: string }
```

### timeout:error

An agent or capsule operation exceeded its configured time limit.

```ts
{ kind: "timeout:error"; message: string; operation?: string; limitMs?: number }
```
