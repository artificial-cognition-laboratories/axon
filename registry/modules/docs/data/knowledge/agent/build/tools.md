---
title: Tools
---

# Tools

Tools are TypeScript functions in `src/tools/`. Export a function and the agent can call
it. No registration, no schema definitions, no wiring.

```ts
// src/tools/github.ts

/** Open a pull request against the base branch. Returns the PR number and URL. */
export async function openPr(title: string, body: string, head: string) {
    const { data } = await octokit.pulls.create({ title, body, head, ...repo() })
    return { number: data.number, url: data.html_url }
}

/** Get the diff for a pull request. */
export async function getPrDiff(number: number): Promise<string> {
    const { data } = await octokit.pulls.get({ pull_number: number, ...repo() })
    return data.diff_url
}
```

Axon reads the TypeScript signatures and JSDoc at boot and hands them to the model as
typed, documented capabilities. You write the function. The agent knows how to use it.

The agent calls exports by name, flat — `tools/github.ts` gives it `openPr` and
`getPrDiff`, not `github.openPr`. The filename groups the file for you; it is not a prefix
the model types. (Your own scripts and routes address the same functions as
`axon.tools.github.openPr` — see [Calling tools yourself](#calling-tools-yourself).)

## Sync or async, always awaited

Write the function either way — both are valid:

```ts
export function add(a: number, b: number) {
    return a + b
}
```

Every call is still `await add(2, 3)`. Tool calls are policy-mediated before the body
runs, and a rule can escalate to the user for approval, which is inherently asynchronous —
so the function installed in the agent's scope is always an async wrapper around yours.
Calling without `await` yields a `Promise`, not the value.

Full detail in [tools/](/docs/v2/agent/src/tools#every-tool-is-async-at-the-call-site).

## Write real JSDoc

The JSDoc *is* the tool's documentation to the model — it's the difference between the
agent guessing at a function and using it correctly. Say what the function does, what it
returns, and anything surprising:

```ts
/**
 * Search the issue tracker. Returns at most 20 results, newest first.
 * Query syntax: plain text, or `label:bug`, `assignee:name` filters.
 */
export async function searchIssues(query: string) { ... }
```

Types are read from the signature — don't repeat them in prose. After adding or changing
tools, `axon prepare` regenerates the type declarations (opening Axon runs it
automatically).

## Where tools run

Tools execute in the capsule — an isolated subprocess, separate from the agent process.
Two consequences you'll feel while building:

**A tool that crashes doesn't crash the agent.** Throws, leaks, even `process.exit()` —
the capsule takes the hit, the runtime surfaces a structured error, the agent adapts.

**Module scope is per-capsule-lifetime.** Clients and caches at module level are cheap
and fine, but they're recreated when the capsule reloads (tool edits, `.env` changes).
Anything the agent must remember across reloads belongs in `data/`.

```ts
// Recreated on capsule reload — fine for a client, wrong for durable state.
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN })
```

Every tool call is also policy-checked before the function body runs — see
[Policy](/docs/v2/agent/policy).

## Calling tools yourself

Tools aren't only for the model. Scripts and routes call them directly, fully typed:

```ts
const diff = await axon.tools.github.getPrDiff(42)
```

## Tools you don't write

Installed modules contribute tool namespaces the same way — `axon install @axon/linear`
and the agent has `linear.*`. Same discovery, same typing, same capsule. See
[Modules](/docs/v2/modules/overview).

---

Next: [Prompts](/docs/v2/agent/src/prompts) — the context the agent loads per task.
