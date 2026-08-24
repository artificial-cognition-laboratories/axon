---
title: axon.config.ts
---

# axon.config.ts

Every agent has one. It declares which engine the agent uses and what the capsule is
allowed to do. Everything else in the folder is discovered automatically — this is the
one file Axon explicitly reads at boot.

```ts
import { defineAgent } from "@axon/sdk"
import { Axon } from "@arcforge/engines"

export default defineAgent({
    engine: Axon(),

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


## `engine`

```ts
import { defineAgent } from "@axon/sdk"
import { Axon, Cerebras, Codex, Ollama, OpenRouter } from "@arcforge/engines"

export default defineAgent({
    engine: Axon(),                                      // Axon Cloud (default)
    // engine: Codex(),                                  // ChatGPT subscription via OAuth
    // engine: Cerebras({ model: "gpt-oss-120b" }),      // Cerebras Inference
    // engine: Ollama({ model: "qwen2.5:7b" }),          // local inference
    // engine: OpenRouter({ model: "openai/gpt-4o" }),   // BYOK, 100+ models
})
```

Engine functions come from `@arcforge/engines`. The connected provider in the TUI (`*` to
switch) overrides this when running locally — the config value is the default for headless
and deployed runs. See [Powering your agent](/docs/v2/getting-started/installation#powering-your-agent)
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
