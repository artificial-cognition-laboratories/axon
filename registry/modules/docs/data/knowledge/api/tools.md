---
title: Tools
---

# Tools

Tool exports are globals. Call them directly from scripts, routes, and hooks — no prefix, no namespace wrapper.

```ts
// src/scripts/triage.ts
const tasks = await kanban.list("open")
const session = await axon.prompt("session", { tasks })
const { stream } = axon.stream({ prompt: session })
```

## Why globals

Tools are primarily called by the agent during its cognitive loop. But scripts often need to call tools directly — to load state before constructing a prompt, to act on the agent's output, or to run work without the loop.

You wrote the function; you should be able to call it. Tools execute in the capsule, a separate subprocess, and the transport is handled for you — a script author never has to know the boundary is there. The same call works from a script, a route handler, a hook, or the agent itself.

## What becomes a global

Each top-level export from `src/tools/*.ts` lands on the global scope with its exact name.

```ts
// src/tools/kanban.ts
export const kanban = {
    list: async (status?: string) => ...,
    add: async (title: string) => ...,
}
```

```ts
// src/tools/time.ts
export async function now() { return new Date().toISOString() }
export async function format(date: string) { ... }
```

The agent and all scripts see: `kanban`, `now`, `format` — each directly callable.

Installed modules keep their namespace: `@axon/github` contributes `github.openPr`, not a bare `openPr`. See [Modules](/docs/v2/modules/overview).

## Always awaited

Every tool call is `await`ed, whether you wrote the function sync or async:

```ts
const sum = await add(2, 3)
```

Each call is policy-checked before the function body runs, and a rule can escalate to the user for approval — a round trip that cannot be synchronous. See [tools/](/docs/v2/agent/src/tools#every-tool-is-async-at-the-call-site).

## axon.tools.\* — the explicit path

The same functions are always reachable under `axon.tools.<file>.<fn>`:

```ts
const tasks = await axon.tools.kanban.list("open")
```

Identical behaviour — same capsule, same policy, same tracing. The globals are bindings onto this surface, not a separate route.

Reach for it when a bare name would be ambiguous or unavailable: a tool whose name collides with a host builtin (a tool called `fetch` will not shadow the real `fetch`, and stays callable as `axon.tools.<file>.fetch`), or code driving a runtime other than its own.

## Typing

`axon prepare` generates `.agent/tool-globals.d.ts` — a `declare global` block declaring each export, with the types read from your source and any type your signature references carried alongside it. Full autocomplete with no imports required.

```ts
// .agent/tool-globals.d.ts — generated, do not edit
declare global {
    type Task = { id: string; title: string; done: boolean }

    /** Fetch the next unfinished task. */
    function next(): Promise<Task | null>

    namespace github {
        function openPr(title: string): Promise<{ number: number; url: string }>
    }
}
```

This file mirrors the scope the model receives — same source, same members — so what your editor tells you and what the agent can call never disagree.

Run `axon prepare` after adding or modifying tool files to refresh types.

## Example — load state before prompting

```ts
const issues = await kanban.list({ status: "open" })
const session = await axon.prompt("session", { issues })

const { stream } = axon.stream({ prompt: session })
```

Loading state explicitly before the prompt is more reliable than letting the agent call the tool itself — you control exactly what data the agent sees.
