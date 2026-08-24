---
title: process.run
---

# process.run

Runs a shell command, waits for it to complete, and returns the result. Never throws —
failures are indicated by `result.ok === false`.

```ts
const result = await process.run("bun test")

if (!result.ok) {
    throw new Error(`Tests failed:\n${result.stderr}`)
}
```

## Signature

```ts
process.run(
    command: string,
    opts?: {
        cwd?: string
        env?: Record<string, string>
        input?: string
    }
): Promise<{
    ok: boolean
    exitCode: number
    stdout: string
    stderr: string
    err?: string   // set when ok === false
}>
```

## Options

**`cwd`** — working directory for the command. Defaults to `process.cwd()`.

**`env`** — additional environment variables merged over `process.env`. The base
environment is always inherited; this only adds or overrides keys.

**`input`** — string written to stdin before the process starts.

## When to use it

Use `process.run()` when you need the complete output before continuing — running a test
suite, building an artifact, calling a CLI that returns structured output.

```ts
// Run tests and surface failures
const tests = await process.run("bun test --reporter=verbose")
if (!tests.ok) throw new Error(tests.stderr)

// Build and read the artifact
const build = await process.run("bun run build", { cwd: workspace.root })
if (!build.ok) throw new Error(`Build failed (exit ${build.exitCode}):\n${build.stderr}`)

// Pass stdin
const result = await process.run("jq '.name'", { input: JSON.stringify({ name: "axon" }) })
console.log(result.stdout.trim()) // "axon"
```

For streaming output or long-running processes, use
[process.spawn](/docs/v2/api/proc/spawn) instead.
