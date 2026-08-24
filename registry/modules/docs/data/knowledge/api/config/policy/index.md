---
title: policy
---

# policy

Declares what the agent's capsule subprocess is allowed to do. Enforced structurally —
not advisory, not a prompt hint. If a call violates policy, it does not execute.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:     ["./src/**", "./docs/**"],
            write:    ["./reports/**"],
            deny:     ["**/.env*", "**/.ssh/**"],
        },
        network: {
            allow:    ["api.github.com"],
            deny:     ["*"],
        },
        process: {
            allow:    ["git *", "bun test"],
            escalate: ["docker *"],
        },
        user:     "axon-agent",
        stripEnv: ["DATABASE_*", "*_SECRET"],
        keepEnv:  ["OPENAI_API_KEY"],
        resources: {
            maxMemoryMb:     512,
            maxCommandTimeMs: 30_000,
        },
    },
})
```

Policy is applied at two independent layers. Both read the same config.

**Mediator gates** run inside the capsule on every platform. Every tool call is evaluated
before the function executes. A denied call never reaches the function body.

**OS-level enforcement** runs on Linux when `user` is set. The capsule subprocess runs as
that system user. Filesystem ACLs derived from `fs` are applied at boot. Sensitive env
vars are stripped before the process starts.

No policy block means unrestricted access — no `fs` block means the capsule can read and
write anything. For anything deployed or published, declare explicit rules.

| Field | What it controls |
|---|---|
| [`fs`](/docs/v2/api/config/policy/fs) | Filesystem reads, writes, and denies |
| [`network`](/docs/v2/api/config/policy/network) | Outbound `fetch()` calls |
| [`process`](/docs/v2/api/config/policy/process) | Shell command spawning |
| [`user`](/docs/v2/api/config/policy/user) | OS user for the capsule subprocess |
| [`env`](/docs/v2/api/config/policy/env) | Env var filtering before boot |
| [`escalate`](/docs/v2/api/config/policy/escalate) | Programmatic approval gate |
| [`resources`](/docs/v2/api/config/policy/resources) | Memory, time, and rate limits |

For the full conceptual model see [Kernel & Policy](/docs/v2/concepts/kernel-and-policy).
