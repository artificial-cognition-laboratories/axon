---
title: resources
---

# resources

Caps on what the capsule can consume across a session. All fields are optional.

```ts
type ResourceLimits = {
    maxMemoryMb?:         number   // max heap in MB
    maxCommandTimeMs?:    number   // max wall-clock ms per command
    maxFileReadBytes?:    number   // max cumulative bytes read via fs across the session
    maxFileWriteBytes?:   number   // max cumulative bytes written via fs across the session
    maxNetworkRequests?:  number   // max outbound fetch() calls across the session
    escalationTimeoutMs?: number   // ms to wait for escalation approval — default: 30000
}
```

```ts
export default defineAgent({
    policy: {
        resources: {
            maxMemoryMb:         512,
            maxCommandTimeMs:    30_000,
            maxFileReadBytes:    10_000_000,
            maxNetworkRequests:  50,
        },
    },
})
```

When a limit is exceeded, the runtime emits a `capsule:resource:exceeded` event, the
operation fails, and the agent is told the limit was hit. Limits are session-scoped —
they reset when the capsule restarts.

## Fields

**`maxMemoryMb`** — enforced via `--max-old-space-size` at spawn plus a watchdog inside
the subprocess. The subprocess is killed if it exceeds this.

**`maxCommandTimeMs`** — wall-clock timeout per command. A command that runs longer than
this is killed with a `resource:exceeded` error. The agent can catch this and try a
different approach.

**`maxFileReadBytes`** — cumulative across all `fs.read` calls in the session. Useful for
agents processing user-supplied files where you want to cap total data ingested.

**`maxFileWriteBytes`** — cumulative across all `fs.write` calls. Caps total data the
agent can write in a session.

**`maxNetworkRequests`** — total outbound `fetch()` calls. Prevents runaway API usage in
loops.

**`escalationTimeoutMs`** — how long to wait for a human to approve or deny an escalated
call before failing closed. Default is 30 seconds. Applies in all execution contexts —
if no TUI is attached, the escalation fails closed immediately after this timeout.
