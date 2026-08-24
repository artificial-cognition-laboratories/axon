---
title: escalate
---

# escalate

Programmatic escalation gate. Called when a tool call matches an `escalate` pattern on
`fs` or `process`, or when you need conditions the pattern lists can't express.

```ts
escalate?: (call: PolicyCall) => boolean
```

Return `true` to pause execution and surface the call for human approval in the TUI.
Return `false` to allow the call to proceed normally (assuming it passes the static
rules).

```ts
export default defineAgent({
    policy: {
        escalate: (call) => {
            // call.fn   — "fs.write", "process.spawn", "network.fetch", etc.
            // call.args — arguments passed to the operation
            return call.fn === "process.spawn"
                && call.args[0]?.toString().includes("--force")
        },
    },
})
```

## How escalation works

When a call escalates, the agent's execution is suspended. The TUI shows the function
name, module, and arguments and waits for a response. Approving lets the call proceed.
Denying throws in the capsule and the agent is told the call was blocked.

In headless execution with no TUI attached, unresolved escalations fail closed after the
timeout. Default is 30 seconds — configurable via
[`resources.escalationTimeoutMs`](/docs/v2/api/config/policy/resources).

## Pattern escalation vs function escalation

Pattern-based escalation on `fs` and `process` covers static cases:

```ts
export default defineAgent({
    policy: {
        process: {
            allow:    ["git *"],
            escalate: ["git push*"],
        },
    },
})
```

The `escalate` function covers cases where the decision depends on the arguments:

```ts
export default defineAgent({
    policy: {
        escalate: (call) => {
            if (call.fn !== "fs.write") return false
            const path = call.args[0]?.toString() ?? ""
            return path.includes("production") || path.includes("deploy")
        },
    },
})
```

Both can be declared simultaneously. Either one triggering is sufficient to escalate —
they are not exclusive.
