---
title: axon.config.ts
---

# axon.config.ts

Every agent has one. It declares which engine the agent uses and what the capsule is
allowed to do. Everything else in the folder is discovered automatically — this is the
one file Axon explicitly reads at boot.

```ts
import { defineAgent } from "@axon/sdk"

export default defineAgent({
    policy: {
        fs: {
            read:  ["./**"],
            write: ["./**"],
            deny:  [".env", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com", "api.linear.app"],
        },
        process: {
            allow: ["git *", "bun *"],
            deny:  ["git push --force*"],
        },
    },

    workspace: true,
})
```


## `model` and `providers`

Most agents declare neither. Inference resolves against the user's own profile
providers, which is what they configured once for their machine — an agent that
names nothing runs on whatever they already have.

```ts
export default defineAgent({
    model: "axon:openai/gpt-5.6-luna",   // a PREFERENCE for the primary role
})
```

`model` is `"<route>:<id>"` and is a preference, never a constraint: if nothing
in the pool can serve it, the resolver picks what can rather than failing.

```ts
import { Ollama } from "@arcforge/engines"

export default defineAgent({
    providers: [Ollama({ url: "http://box.local:11434" })],
})
```

`providers` ADDS a source the user would not otherwise have. It can never
displace or remove one of theirs — the machine belongs to the person running
it, and an installed agent quietly rerouting their inference is exactly what
this split prevents.

> **`engine:` was removed.** It named one model for the whole agent, could not
> survive a cognet declaring several roles, and put the choice in the wrong
> place. A config still carrying it is refused at load; `axon prepare` rewrites
> it to `model:` automatically the next time the agent runs.

Provider functions come from `@arcforge/engines`. The model picked in the TUI
(`*` to switch) edits this agent's own `model:` — a model is a property of an
agent, not something you run instead of one. See [Powering your agent](/docs/v2/getting-started/installation#powering-your-agent)
for the provider options.

## `policy`

Controls what the capsule subprocess is allowed to do. Three rule groups plus an optional
`escalate` callback for decisions that need context.

```ts
export default defineAgent({
    policy: {
        fs: {
            read:  ["./src/**"],
            write: ["./src/**"],
            deny:  [".env", "**/node_modules/**"],
        },
        network: {
            allow: ["api.github.com"],
        },
        process: {
            allow: ["git *", "bun *"],
            deny:  ["git push --force*"],
        },
        escalate: call =>
            call.fn === "process.spawn" && call.args[0]?.includes("push --force"),
    },
})
```

A missing block means unrestricted access in that domain — no `fs` block means the capsule
can read and write anywhere. For production agents, always declare explicit rules.

See [Policy](/docs/v2/agent/policy) for the full reference.

## Environment

Environment variables don't live in the config — the agent's `.env` file is the source
of truth, like any other project. Putting a key there is the explicit act of giving the
agent that key. See [Environment & Secrets](/docs/v2/agent/environment).

## `workspace`

```ts
export default defineAgent({ workspace: true })
```

Opts the agent into the nearest `.agents/` folder in the directory tree. When true, Axon
walks upward from the agent's working directory, finds the workspace layer, and merges its
tools, prompts, scripts, and modules into the agent's runtime.

See [Workspace Agents](/docs/v2/workspace) for the full guide.

## Why one file

Everything declared in one TypeScript file means the agent is readable at a glance. One
file changed is one diff to review. The `escalate` callback can contain real logic —
conditions, pattern matching, context-sensitive decisions — which a JSON config file can't.
