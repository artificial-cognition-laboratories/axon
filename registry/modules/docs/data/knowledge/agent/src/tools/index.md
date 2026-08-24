---
title: tools/
icon: vscode-icons:folder-type-tools
---

# tools/

Export anything from `.ts` files in `src/tools/` and it becomes a global in the agent's execution scope. No registration, no schema definition, no `defineTool`.

```bash
my-agent/
└── src/
    └── tools/
        ├── github.ts
        ├── kanban.ts
        └── time.ts
```

Each file's exports land directly on the global scope. The filename groups the file; it is
not a prefix. What you export is what the agent calls.

## Export shapes

Any export form works.

**Named functions** — each function becomes its own global:

```ts
// src/tools/time.ts
export async function now() {
    return new Date().toISOString()
}

export async function format(date: string, locale = "en-GB") {
    return new Intl.DateTimeFormat(locale).format(new Date(date))
}
```

The agent gets `now` and `format` as top-level globals. Not `time.now` — the file is a
grouping for you, not a namespace for the agent.

**Named object** — the object itself becomes a global:

```ts
// src/tools/kanban.ts
export const kanban = {
    list: async (status?: string) => db.tasks.findAll({ status }),
    add: async (title: string) => db.tasks.create({ title }),
    close: async (id: string) => db.tasks.update(id, { status: "done" }),
}
```

The agent gets `kanban` as a global. Calls it as `kanban.add("task")`.

## Calling tools

The agent calls tools like any other code — the export name is the call name, with no
prefix:

```ts
const tasks = await kanban.list("open")
const pr = await openPr("fix: auth", body, "feat/auth")
const ts = await now()
```

(From a script or route you reach the same functions through `axon.tools.*` instead — see
[Calling tools from your own code](#calling-tools-from-your-own-code).)

## Every tool is async at the call site

**Write your tool sync or async — both work. It is always called with `await`.**

```ts
// src/tools/math.ts — a perfectly valid tool
export function add(a: number, b: number) {
    return a + b
}
```

```ts
const sum = await add(2, 3)   // 5
```

This is not a style preference; it is structural. Every tool call is policy-mediated
before the function body runs, and a policy rule can be `escalate` — which asks the user
to approve the call and waits for the answer. That round trip cannot happen synchronously,
so the function Axon installs in the agent's scope is always an async wrapper around
yours. A sync tool body is fine. A sync *call* is not available, for any tool.

The practical consequence: `add(2, 3)` without `await` gives you a `Promise`, not `5`.

```ts
const wrong = add(2, 3)          // Promise<number>
const wrong2 = add(2, 3) * 2     // NaN — no error, just wrong

const right = await add(2, 3)    // 5
```

If you don't need a sync body for anything, writing `async function` makes the call site
and the signature agree, and is the easier habit.

See [Policy](/docs/v2/agent/policy) for what mediation checks and how escalation is
configured.

## What the agent sees

Tool types come from your TypeScript signatures directly — run through real TypeScript
declaration emission, so inferred return types are the compiler's actual inference, not
`unknown`. Write JSDoc as if explaining to someone who has never seen your codebase —
that's the model deciding when and how to call the function.

```ts
// src/tools/github.ts

/** List all open pull requests for the configured repository. */
export async function listOpenPrs(): Promise<{ number: number; title: string }[]> {
    const { data } = await octokit.pulls.list({ state: "open", ...repo() })
    return data.map(pr => ({ number: pr.number, title: pr.title }))
}

/** Open a pull request. Returns the PR number and URL. */
export async function openPr(
    title: string,
    body: string,
    head: string,
    base = "main"
): Promise<{ number: number; url: string }> {
    const { data } = await octokit.pulls.create({ title, body, head, base, ...repo() })
    return { number: data.number, url: data.html_url }
}
```

### Types your signature references

When a signature mentions a type you declared elsewhere — an interface, a type alias — that
declaration is followed and carried alongside the tool, so the agent sees the full shape
rather than a bare name:

```ts
// src/tools/tasks.ts
type Task = { id: string; title: string; done: boolean }

/** Fetch the next unfinished task. */
export async function next(): Promise<Task | null> { ... }
```

The agent receives both the `next()` signature and the `Task` definition.

Prefer plain data — interfaces, type aliases, object shapes — for anything a tool returns.
The agent only ever receives the serialized *value* of a return, so a returned class
instance arrives as its plain fields: methods are not callable across the capsule boundary,
and `instanceof` means nothing on the other side. A tool returning a rich class is usually
better expressed as one returning a plain object, with the class kept internal:

```ts
// src/tools/dice.ts
import { Roll } from "../lib/roll"

type RollResult = { spec: string; dice: number[]; total: number }

/** Roll dice from a spec like "2d6+3". Returns the individual dice and the total. */
export async function roll(spec: string): Promise<RollResult> {
    const r = new Roll(spec)          // class stays internal
    return { spec, dice: r.dice, total: r.total }
}
```

A class named in a signature *is* carried across — the model sees its declared shape, not
a bare name. What it does not get is behavior: the agent receives the serialized value, so
returning a plain object is still the clearer contract.

Two tool files declaring the same type name with different shapes is an error, not a
silent pick. Rename one, or move the shared definition into a file both import.

## Module scope is persistent

The capsule process starts at boot and stays alive for the session. Module-level code in `tools/` runs once and persists for the entire session. Use this for clients, connections, and caches.

```ts
// src/tools/github.ts
import { Octokit } from "@octokit/rest"

// Instantiated once at boot — reused across every call
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })

export async function listOpenPrs() { ... }
```

No re-authentication per call. No cold-start latency per invocation.

## Sharing code between files

Files in `tools/` can import from each other. A file with no exports contributes nothing to the global scope — use it as a shared internal module.

```ts
// src/tools/_http.ts — underscore prefix, nothing exported to global scope
export function buildHeaders(token: string) {
    return { Authorization: `Bearer ${token}` }
}
```

```ts
// src/tools/github.ts
import { buildHeaders } from "./_http"

export async function openPr(title: string, body: string, head: string) {
    const headers = buildHeaders(process.env.GITHUB_TOKEN!)
    // ...
}
```

## Calling tools from your own code

Tools aren't only for the model. Scripts, routes and hooks call them the same way the
agent does — by name, no prefix:

```ts
// In a script or route handler
const prs = await listOpenPrs()
const sum = await add(2, 3)
```

The same functions are always also reachable explicitly:

```ts
const prs = await axon.tools.github.listOpenPrs()
```

Identical behaviour — same capsule, same policy, same tracing; the globals are bindings
onto that surface. Use the explicit form when a bare name would be ambiguous: a tool whose
name collides with a host builtin is not installed as a global (a tool called `fetch` will
not shadow the real one) and stays callable as `axon.tools.<file>.fetch`.

Both are `await`ed — see [above](#every-tool-is-async-at-the-call-site).

## IDE support

`axon prepare` generates `.agent/tool-globals.d.ts`, which declares each export as a typed global. Full autocomplete in scripts, routes, and hooks without any imports.

Run `axon prepare` after adding or changing files in `tools/` to refresh types.
