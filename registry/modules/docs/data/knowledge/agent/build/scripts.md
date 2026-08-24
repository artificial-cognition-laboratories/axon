---
title: Scripts
---

# Scripts

Scripts are TypeScript files in `src/scripts/`. They orchestrate work: load context,
call the agent, process results, write files. This is the primary authoring unit — most
of what your agent *does* is a script.

```ts
// src/scripts/review.ts
const { file } = defineArgs<{ file: string }>()

const content = await axon.tools.fs.readFile(file)
const prompt = await axon.prompt("review", { file, content })

const { stream } = axon.stream({ prompt })

for await (const entry of stream) {
    if (entry.type === "text") process.stdout.write(entry.content)
}
```

A script can do anything TypeScript can do. Calling the agent is one option, not the
default — the script decides when reasoning is needed. Fetch data, transform it, and
only bring in the agent for the step that actually requires judgment.

## The two calls

**`axon.request()`** — send a task, await the full result. Use it when you need the
answer before continuing.

```ts
const result = await axon.request({ prompt })
// result.text — the agent's output, ready to use
```

**`axon.stream()`** — send a task, receive entries as the loop produces them. Use it
when output should flow somewhere incrementally — a terminal, an HTTP response, a chat
surface.

```ts
const { stream } = axon.stream({ prompt })
for await (const entry of stream) { ... }
```

Both take a plain string as shorthand: `await axon.request("summarise the open issues")`.

## Arguments

`defineArgs` declares what the script takes. Typed, validated at invocation:

```ts
const { file, verbose } = defineArgs<{ file: string; verbose?: boolean }>()
```

```bash
axon run review --file src/index.ts --verbose
```

## Scripts that need more than one agent

A script in `src/scripts/` belongs to its agent, and `axon` is that agent. When work
needs a second one — a reviewer to check the reviewer, a specialist for one step — it
belongs in a [global script](/docs/v2/fleet/code) instead: an ordinary `*.axon.ts`
file that boots the agents it needs and composes them.

```ts
// review.axon.ts
const { barry, checker } = await Fleet({ barry: "../barry", checker: "../checker" })
```

See [Working with Agents](/docs/v2/fleet).

## One script, four doors

The same script runs identically from everywhere. Write it once:

```bash
axon run review --file src/index.ts     # headless, from the terminal
```

- **TUI** — not currently exposed; run scripts from the CLI.
- **HTTP route** — `axon.scripts.stream("review")` from a handler in `server/api/`.
- **Another script** — `axon.scripts.request("review", { file })`.

Headless runs are the fast feedback loop: the agent boots, the script runs, the agent
exits. No session to set up, no interface in the way.

---

Next: [Fleet](/docs/v2/fleet) — composing work across several agents.
