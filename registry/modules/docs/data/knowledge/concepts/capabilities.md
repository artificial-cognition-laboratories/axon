---
title: Capabilities
---

# Capabilities

Tools, prompts, and scripts are the three authoring primitives. Everything an agent can do or know is expressed through one of them.

## Tools

Tools are exported async TypeScript functions in `src/tools/`. Each file in that directory becomes a named tool namespace — the filename becomes the namespace, the exports become callable functions.

```ts
// src/tools/kanban.ts
export async function list(): Promise<Task[]> { ... }
export async function createTask(title: string): Promise<Task> { ... }
```

The agent calls them by name during its loop. Your scripts call them directly via `axon.tools.ns.fn(args)`. Both paths go through the capsule — policy enforcement applies to every call regardless of who initiated it.

Tools are declared to the model via JSDoc. Write documentation as if explaining to someone who cannot see your implementation — because that is exactly what happens.

## Prompts

Prompts are reusable context templates in `src/prompts/`. They render to text at invocation time, optionally accepting variables.

```ts
const prompt = await axon.prompt("repo-review", { repo, branch })
const { stream } = axon.stream({ prompt })
```

Prompts can be plain Markdown or Vuedown files (`.vue`) with a `<script setup>` block that fetches live data at render time. A prompt that loads the current sprint state, open issues, and recent commits gives the agent a hydrated snapshot of the world — more reliable than letting the agent call tools to gather it.

Pass an array to compose multiple prompts. Axon concatenates them in order.

## Scripts

Scripts are TypeScript files in `src/scripts/`. Each script is an explicit automation — it gathers context, calls tools, invokes the agent loop, and produces output.

```ts
// src/scripts/close-plan.ts
const { issueId } = defineArgs<{ issueId: string }>()
const prompt = await axon.prompt("close-plan", { issueId })
const { stream } = axon.stream({ prompt })

for await (const entry of stream) {
    if (entry.type === "text") process.stdout.write(entry.content)
}
```

Scripts are invoked four ways: `axon run <name>` from the CLI, `!<name>` from the TUI palette, `axon.scripts.request/stream()` from another script or route, or via an HTTP route that calls `axon.scripts.stream`. The script is always the logic owner — routes are thin wrappers that expose scripts over HTTP.

## Modules

A module packages any combination of tools, prompts, scripts, and routes for installation into another agent. Installed modules contribute to the same namespaced surfaces — `axon.tools.<module>.*`, `axon.prompt("<module>:name")` — subject to the host agent's policy.

See [Modules](/docs/v2/concepts/modules) for how modules work, and [Modules tab](/docs/v2/modules/overview) for authoring them.
