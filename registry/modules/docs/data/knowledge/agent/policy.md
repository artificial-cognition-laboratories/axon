---
title: Policy
---

# Policy

The `policy` block in `axon.config.ts` controls what the agent's capsule subprocess is
allowed to do. Enforcement is structural — not advisory, not a prompt hint. If a call
violates the policy, it does not execute.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**", "./package.json"],
            write: ["./src/**", "./CHANGELOG.md"],
            deny:  ["**/.env*", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
        process: {
            allow: ["git *", "bun *"],
            deny:  ["git push --force*"],
        },
    },
})
```

No policy block means unrestricted access, not denied access. A missing `fs` block gives
the agent full filesystem access. Development agents often run without any policy — that
is intentional. For anything deployed or published, declare explicit rules.

## Enforcement layers

Policy is applied at two independent layers. You write it once. The runtime applies it at
every layer available on the host.

**Mediator gates** run inside the capsule on every platform. Every tool call is evaluated
against the policy rules before the function executes. A denied call never reaches the
function body.

**OS-level enforcement** runs on Linux when `user` is set. The capsule subprocess runs as
a different system user. Filesystem ACLs derived from the `fs` policy are applied at boot.
Sensitive env vars are stripped before the process starts. This layer is independent of
the mediator — it closes gaps the mediator can't address.

## Writing policy

### Mediator-only (all platforms)

The default. Declare `fs`, `network`, and `process` rules. The mediator enforces them.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**", "./tests/**", "./package.json"],
            write: ["./src/**"],
            deny:  ["**/.env*", "**/*.key", "**/*.pem", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
        process: {
            allow: ["git status", "git diff *", "git add *", "git commit *", "bun test"],
            deny:  ["git push --force*", "rm -rf *"],
        },
    },
})
```

### With OS-level enforcement (Linux)

Add `user` to run the capsule subprocess as a dedicated system user. The runtime handles
everything else automatically.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**", "./tests/**", "./package.json"],
            write: ["./src/**"],
            deny:  ["**/.env*", "**/*.key", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
        process: {
            allow: ["git *", "bun test"],
            deny:  ["git push --force*"],
        },
        user: "axon-agent",
        keepEnv: ["GITHUB_TOKEN"],
    },
})
```

At boot, the runtime applies `setfacl` ACLs for `axon-agent` derived from the `fs`
policy, strips sensitive env vars (preserving `GITHUB_TOKEN` from `keepEnv`), and
launches the capsule as `axon-agent`. The subprocess and everything it spawns runs as
that user.

On macOS and Windows, `user` has no effect. OS enforcement is Linux only.

## Escalation

For calls where a static allow/deny isn't expressive enough, escalation pauses execution
and surfaces the call for human review.

Escalation can be declared per-domain with pattern lists:

```ts
export default defineAgent({
    policy: {
        process: {
            allow:    ["git *"],
            escalate: ["git push*"],
        },
        fs: {
            read:     ["./**"],
            escalate: ["./secrets/**"],
        },
    },
})
```

Or programmatically with a function when the condition depends on the arguments:

```ts
export default defineAgent({
    policy: {
        escalate: call => {
            // call.fn   — e.g. "fs.write", "process.spawn"
            // call.args — the arguments passed to the operation
            return call.fn === "process.spawn" && call.args[0]?.toString().includes("--force")
        },
    },
})
```

When a call escalates, the TUI shows the function, module, and arguments and waits for
approval or denial. In headless execution with no TUI attached, escalations fail closed
after the timeout (default 30 seconds, configurable via `resources.escalationTimeoutMs`).

## Per-invocation narrowing

The base policy applies to every invocation. Scripts and routes can narrow it for a
single call:

```ts
// server/api/support.post.ts
export default defineEventHandler(async event => {
    const ticket = await readBody(event)
    const prompt = await axon.prompt("support-triage", { ticketId: ticket.id })

    return axon.request({
        prompt,
        policy: {
            fs:      { read: false, write: false },
            network: { allow: ["api.stripe.com"] },
            process: { allow: [] },
        },
    })
})
```

Narrowing can only restrict. A call cannot grant access to something the base policy
already denies. The narrowed policy is cleared when the invocation completes.

## Resource limits

Alongside access control, policy accepts resource limits that cap what the agent can
consume across a session:

```ts
export default defineAgent({
    policy: {
        fs: { read: ["./**"] },
        resources: {
            maxMemoryMb:        512,
            maxCommandTimeMs:   30_000,
            maxFileReadBytes:   10_000_000,
            maxNetworkRequests: 50,
        },
    },
})
```

For the complete field reference — all options, types, and defaults — see
[Policy reference](/docs/v2/api/config/policy).
