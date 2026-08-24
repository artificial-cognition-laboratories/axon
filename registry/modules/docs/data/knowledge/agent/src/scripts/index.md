---
title: scripts/
icon: vscode-icons:folder-type-script
---

# scripts/

Scripts are TypeScript files in `src/scripts/`. They are the primary authoring unit —
load prompts, call the agent, process results, write files, call tools, spawn processes.
Full TypeScript, no restrictions.

The script name is the filename without extension:

```bash
scripts/scout.ts          → "scout"
scripts/close-plan.ts     → "close-plan"
scripts/learn.ts          → "learn"
```

## Globals

Scripts have three globals injected at runtime — no imports needed:

| Global | What it is |
|---|---|
| `axon` | Agent API — `request`, `stream`, `prompt`, `tools`, `scripts`, `proc`, `ui` |
| `args` | Arguments passed to this script |
| `defineArgs` | Declare and type the expected args |

## A complete script

```ts
// src/scripts/learn.ts
// axon run learn --domain tracing

import { readFile, writeFile } from "fs/promises"
import { join } from "path"

const { domain } = defineArgs<{ domain: string }>()

const knowledgeRoot = join(import.meta.dir, "../../data/knowledge")

const rulebook = await readFile(
    join(knowledgeRoot, "rulebooks", `${domain}.md`), "utf-8"
)

const existing = await readFile(
    join(knowledgeRoot, "domains", `${domain}.md`), "utf-8"
).catch(() => null)

const context = await axon.prompt("context")
const task    = await axon.prompt("learn", { domain, rulebook, existing })

const { stream } = axon.stream({ prompt: [context, task] })

let output = ""

for await (const entry of stream) {
    if (entry.type === "text") {
        process.stdout.write(entry.content)
        output += entry.content
    }
}

const match = output.match(/```knowledge\n([\s\S]*?)```/)
if (match) {
    await writeFile(
        join(knowledgeRoot, "domains", `${domain}.md`),
        match[1].trim(), "utf-8"
    )
}
```

## Declaring args

`defineArgs<{}>()` types the `args` object, validates required args before the script
runs, and drives the TUI palette form for interactive invocation.

```ts
const { issueId, notify = "true" } = defineArgs<{
    issueId: string   // required
    notify?: string   // optional, defaults to "true"
}>()
```

Without `defineArgs`, `args` is an untyped `Record<string, string>`.

## Invocation

The same script file runs from four places without modification. You don't write a CLI
entrypoint, a route handler, and a programmatic API separately — you write the script
once and the runtime adapts to the context it's called from.

**CLI** — headlessly, agent boots and exits when done:

```bash
axon run scout
axon run learn --domain tracing
axon run close-plan --issueId bd-yiq
```

**TUI palette** — not currently exposed. If the script
declares required args, an inline form appears.

**HTTP route** — expose via `axon.scripts.stream()`:

```ts
// server/api/scout.post.ts
export default defineEventHandler(() => {
    const { stream } = axon.scripts.stream("scout")
    return stream
})
```

**Programmatic** — from another script:

```ts
const result = await axon.scripts.request("close-plan", { issueId: "bd-yiq" })
const { stream } = axon.scripts.stream("scout")
```

## `axon.tools` vs `axon.proc`

Two execution primitives:

**`axon.tools.ns.fn(args)`** — call typed tool functions from `src/tools/` or installed
modules. Returns the function's return value.

```ts
const issues = await axon.tools.kanban.list()
const task = await axon.tools.kanban.nextTask()
```

**`axon.proc.spawn(cmd)`** — spawn a shell command. Returns a `ProcHandle` for streaming
output and checking exit status.

```ts
const proc = axon.proc.spawn("git push --set-upstream origin HEAD")

for await (const line of proc.watch()) {
    process.stdout.write(line + "\n")
}

if (proc.exitCode !== 0) throw new Error(`Push failed`)
```

Use `axon.tools` for typed functions. Use `axon.proc` for shell commands. They are not
interchangeable.

## Calling the agent

A script that calls `axon.request()` or `axon.stream()` invokes the managed agent loop.
A script that doesn't is pure automation — it calls tools, runs processes, writes files.
Both are valid.

```ts
// pure automation — no agent loop
const issues = await axon.tools.kanban.list()
await writeFile("report.md", formatReport(issues), "utf-8")

// agent-backed — loads context, invokes agent, processes output
const prompt = await axon.prompt("code-review", { issueId })
const { stream } = axon.stream({ prompt })
for await (const entry of stream) { ... }
```

## Headless behaviour

When running headlessly via `axon run`, there is no connected TUI host. `axon.ui.ask()`
returns `{ unavailable }`. Scripts that depend on user input should handle this case and
fail closed rather than hanging.
