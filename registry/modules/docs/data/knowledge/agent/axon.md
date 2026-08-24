---
title: axon
---

# axon

The `axon` global is the agent runtime API. Available in scripts and route handlers.
There is no cross-agent access — `axon` is always scoped to the running agent instance.

## `axon.request`

One-shot invocation. Sends a task to the agent loop and awaits the full result.

```ts
// Shorthand — plain string
const result = await axon.request("hello")

// With options
const result = await axon.request({
    prompt,           // string | AxonRenderedPrompt | (string | AxonRenderedPrompt)[]
    policy: { ... },  // Narrowing only. Cannot expand base policy.
    output,           // string — a TypeScript type the response must match
    retries,          // number — attempts after a failed output check (default 2)
})

// result: { text: string, entries: AnyThreadEntry[] }
```

### Structured output

Pass `output` to get an object back instead of prose. It is a TypeScript type written as
a string — checked before the model is called, shown to the model as its target, and
enforced against what it produces.

```ts
const result = await axon.request({
    prompt: "audit src/ and report every issue",
    output: "{ files: number, issues: { file: string, line: number }[] }",
    retries: 3,
})
```

An invalid type throws at the call site before any inference is spent. A response that
fails its check goes back to the model as a TypeScript diagnostic to correct; when the
retry budget runs out the request throws rather than returning an unvalidated value.

See [Structured Output](/docs/v2/concepts/structured-output) for the full picture.

## `axon.stream`

Streaming invocation. Returns an async generator that yields entries as the loop produces them.

```ts
// Shorthand
const { stream } = axon.stream("hello")

// With options — same shape as axon.request
const { stream } = axon.stream({
    prompt,
    policy: { ... },
    output,           // enforced exactly as on request()
    retries,
})

for await (const entry of stream) { ... }
```

Use `axon.stream` when forwarding output incrementally — chat surfaces, long-running tasks,
progress display.

`output` works here too, and enforces the same contract: `request()` is `stream()`
drained, so a shape can never be demanded of one and skipped by the other. The difference
is *when* a failure reaches you — the iteration throws at your `for await` once the retry
budget is spent, with the failure event yielded immediately before it. See
[Structured Output](/docs/v2/concepts/structured-output#streaming).

## One agent, one conversation

`axon` is this agent, and this agent is a single continuous context. Consecutive calls
share full history; there is no sub-context to address and no `thread` parameter.

Work that needs an isolated context needs a second agent. See
[Working with Agents](/docs/v2/fleet) — booting several, composing them, and how they
talk to each other.

## `axon.prompt`

Render an authored prompt from `src/prompts/` or an installed module. Returns a rendered
prompt object to pass to `axon.request` or `axon.stream`.

```ts
const context = await axon.prompt("project-context")
const review  = await axon.prompt("code-review", { issueId: "bd-42" })

// compose multiple prompts — Axon concatenates in order
const { stream } = axon.stream({ prompt: [context, review] })
```

## `axon.scripts`

Invoke another script from within a script or route.

```ts
// collect all entries
const result = await axon.scripts.request("close-plan", { issueId: "bd-yiq" })

// stream entries as they arrive
const { stream } = axon.scripts.stream("scout")
for await (const entry of stream) { ... }
```

## `axon.tools`

Call installed tool functions by namespace. Typed — `axon prepare` generates declarations.

```ts
const issues = await axon.tools.kanban.list()
const pr = await axon.tools.github.openPr("fix: auth", "...", "feat/auth")
```

## `axon.proc`

Spawn shell commands. Returns a `ProcHandle` for streaming output and checking exit status.

```ts
const proc = axon.proc.spawn("git push --set-upstream origin HEAD")

for await (const line of proc.watch()) {
    process.stdout.write(line + "\n")
}

if (proc.exitCode !== 0) throw new Error("Push failed")
```

## `axon.capabilities`

Query what the current engine supports. Synchronous — the engine declares capabilities
at boot.

```ts
const caps = axon.capabilities()
// → { text: boolean, audio: boolean, image: boolean }

if (caps.image) {
    // include image attachments in the prompt
}
```

## `axon.hooks`

Subscribe to lifecycle and module events. Use in server plugins.

```ts
axon.hooks.hook("github:issue.opened", async ({ number, title }) => {
    const prompt = await axon.prompt("issue-triage", { number, title })
    await axon.request({ prompt })
})
```

Modules emit named hooks from their routes using `axon.hooks.callHook(event, payload)`.

## `axon.ui`

Request input from a connected TUI host. Returns `{ unavailable }` when running headlessly.

```ts
const response = await axon.ui.ask({
    message: "Which approach should I take?",
    options: ["refactor", "rewrite", "leave it"],
})

if ("unavailable" in response) {
    // no connected host — proceed with default or abort
}
```

## Where `axon` is available

| Context | Available |
|---|---|
| Script body | ✓ |
| Route handler (`server/api/`) | ✓ |
| Dynamic prompt `<script setup>` | ✓ |
| Server plugins and middleware | Lifecycle setup APIs only |
| `src/tools/` functions | ✗ — tools run inside the capsule, not as callers of the runtime |
