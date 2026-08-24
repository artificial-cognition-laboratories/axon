---
title: The Agent's World
---

# The agent's world is the capsule

The agent has one way to interact with the world: a `<typescript>` block that executes in
the capsule. Everything it can read, write, run, or delegate flows through that boundary.
`<text>` communicates with the user. Everything else is code.

That boundary is not a limitation — it's a complete runtime. The capsule runs on the
user's machine, in a full Bun process, with access to the filesystem, the shell, and the
network. The tool namespaces (`fs`, `process`, `subagent`) are the common-case surface.
Below them is the full TypeScript language.

## The tool namespaces

Every `<typescript>` block executes with these namespaces in scope, declared in the
`<env>` block of the AIR context:

**`fs`** — filesystem operations. Read, write, list, edit, search. The edit operations
are typed and atomic — multiple ops applied in one call, each reporting success or failure
individually.

**`process`** — shell execution. `process.run()` for blocking commands, `process.spawn()`
for long-lived processes. Both run real OS processes on the user's machine with real
stdout, stderr, and exit codes.

**`subagent`** — agent delegation. Spawn another agent instance with a focused prompt.
Wait for its result or run it in the background.

**`axon`** — the agent's own API. The agent can call `axon.request()` from within a
tool execution, spinning up a full cognitive loop mid-task — load a prompt, delegate to
the loop, get the result back as a string. Scripts, events, and prompts are all reachable
the same way.

These are conveniences, not constraints. The agent can `await fetch()`, use
`Promise.all`, import from `node:crypto`, write a stream to disk, or do anything else
Bun supports. The namespaces exist because reading a file or running a command should be
a one-liner — not because they're the only things available.

## Full-language composition

Because the output is TypeScript, not a function call, the agent composes freely within a
single block:

```ts
// Read three files in parallel, process the results, write once
const [src, tests, config] = await Promise.all([
    fs.read("src/index.ts"),
    fs.read("src/index.test.ts"),
    fs.read("axon.config.ts"),
])

const issues = src.split("\n")
    .map((line, i) => ({ line: i + 1, content: line }))
    .filter(({ content }) => content.includes("TODO"))

await fs.write("issues.json", JSON.stringify(issues, null, 2))
```

No round-trips. No separate tool calls for each file. One block, one stdout, one tick.

The agent splits into a new turn only when it genuinely needs to observe a result before
knowing what to do next. Everything that can be determined ahead of time runs together.

## Subprocesses

`process.run()` blocks until the command exits and returns stdout, stderr, and exit code.
For anything that needs to stay alive — a dev server, a watcher, a build process —
`process.spawn()` returns a handle:

```ts
const server = process.spawn("bun run dev", { cwd: "." })

// Wait for it to be ready
await server.waitFor("ready in")

// Check on it later
const output = server.stdout()
```

Spawned processes appear in the `<env>` block on subsequent ticks. The agent can see
their current output and status without querying — they're part of the context it
receives.

## Subagents

`subagent.request()` spawns another agent instance with a focused task and waits for the
result. The spawned agent runs its own full cognitive loop — tools, context assembly, stop
conditions — and returns when it's done.

```ts
const analysis = await subagent.request(
    "Read the test coverage report and list every module below 80% coverage."
)
```

For tasks that can run in parallel:

```ts
const [coverage, deps, types] = await Promise.all([
    subagent.request("Summarise test coverage gaps"),
    subagent.request("Check for outdated dependencies"),
    subagent.request("Find any type errors in src/"),
])
```

Each subagent runs independently. They don't share state, don't see each other's
timelines, and don't coordinate. The parent agent receives their text output and decides
what to do with it.

A running subagent appears in the parent's `<env>` block with its current status and
partial output. The parent can see work in progress without waiting for it to finish.

## What this means in practice

The agent doesn't call a limited set of functions from a registry. It writes code. The
distinction matters when the task doesn't fit neatly into any predefined tool:

```ts
// No "files changed in last commit" tool needed
const result = await process.run("git diff --name-only HEAD~1")
const changedFiles = result.stdout.trim().split("\n").filter(f => f.endsWith(".ts"))
```

```ts
// No "watch for test failure" tool needed
const runner = process.spawn("bun test --watch")
const { line } = await runner.waitFor(/FAIL|error/)
await runner.kill()
```

The tool namespaces cover the common patterns. The language covers everything else.

## Policy as the real boundary

All of this — filesystem access, subprocess execution, network calls, subagent spawning —
runs through the policy gate declared in `axon.config.ts`. The capsule enforces it before
any function executes. The breadth of what's available doesn't mean the agent can do
anything; it means the agent can do anything *you've allowed*.

An agent with `fs: { read: ["./src/**"] }` can read source files and nothing else. The
full runtime is present. The policy decides how much of it the agent can reach.

See [Kernel & Policy](/docs/v2/concepts/kernel-and-policy) for the enforcement model
and what it does and does not protect against.
