---
title: process
---

# process

Controls which shell commands the agent can spawn via `axon.proc.spawn()`. Patterns match
against the full command string passed to spawn.

```ts
type ProcessPolicy = {
    allow?:    string[]   // permitted command patterns
    deny?:     string[]   // blocked command patterns
    escalate?: string[]   // pause and prompt before allowing
}
```

`deny` is checked before `allow`. Patterns use glob-style wildcards against the complete
command string.

```ts
export default defineAgent({
    policy: {
        process: {
            allow:    ["git *", "bun *", "npm *"],
            deny:     ["git push --force*", "rm -rf *"],
            escalate: ["docker *"],
        },
    },
})
```

No `process` block means unrestricted command spawning. For production agents, always
declare a `process` policy.

## Pattern matching

Patterns match the full command string including arguments. `git *` matches any git
subcommand. `git push` matches only that exact command with no arguments. `git push *`
matches `git push` followed by anything.

`deny` takes precedence — a command matching both `allow` and `deny` is blocked.

## escalate

Commands matching `escalate` pause execution and surface the call for human approval.
Useful for commands that are sometimes safe and sometimes destructive depending on
arguments.

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

See [`escalate`](/docs/v2/api/config/policy/escalate) for the programmatic escalation
function.
