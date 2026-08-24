---
title: process.spawn
---

# process.spawn

Starts a shell command and returns a `LiveProcHandle` immediately. The process runs
in the background, tracked by the capsule and visible to the agent in the AIR
`<processes>` context on each cognitive tick.

```ts
const proc = process.spawn("bun dev")
await proc.waitFor("ready on port")
```

## Signature

```ts
process.spawn(
    command: string,
    opts?: {
        cwd?: string
        env?: Record<string, string>
    }
): LiveProcHandle
```

## LiveProcHandle

### State

```ts
proc.procId     // string — unique ID tracked by the capsule
proc.command    // string — original command string
proc.pid        // number | undefined
proc.cwd        // string | undefined
proc.status     // "running" | "exited"
proc.exitCode   // number | undefined — set after exit
proc.startedAt  // number — unix ms
proc.endedAt    // number | undefined — set after exit
```

### Interaction

```ts
proc.kill()             // terminate the process
proc.stdin(data)        // write a string to stdin
```

### Output

All output methods return buffered content captured since spawn.

```ts
proc.stdout()                        // full stdout as string
proc.stdout("stderr")                // stderr only
proc.stdout(["stdout", "stderr"])    // both streams interleaved
proc.tail(n)                         // last n lines
proc.extract(regex)                  // all regex matches from stdout
```

### Waiting

```ts
// Resolves when the process exits
const { exitCode, ok, stdout } = await proc.exited

// Resolves when a line matches the pattern
const { line, stdout } = await proc.waitFor("Listening on")
const { line }         = await proc.waitFor(/ready/, { timeoutMs: 10_000 })
```

### Streaming

```ts
// Async generator — yields every line as it arrives
for await (const line of proc.watch()) { ... }

// Filtered — yields only lines matching the pattern
for await (const line of proc.watch(/compiled in/)) { ... }

// Subscribe with a callback — returns an unsubscribe function
const off = proc.on(/error/, line => console.error(line))
off() // unsubscribe
```

### Querying buffered output

```ts
const snapshot = proc.query({
    search: "FAIL",        // substring match
    regex: /FAIL\s+\d+/,  // regex match (use one or the other)
    context: 3,            // lines before and after each match
    lines: 100,            // limit total lines considered
    include: ["stdout", "stderr"],
    caseSensitive: false,
})

// snapshot.lines          — all lines in the buffer
// snapshot.matches        — matched entries with .text, .before, .after
// snapshot.totalLines
// snapshot.matchedLines
// snapshot.raw            — full buffer as a single string
```

## Patterns

### Wait for a server to be ready

```ts
const server = process.spawn("bun run server.ts")
await server.waitFor("Listening on", { timeoutMs: 15_000 })

// server is ready — do work
const result = await axon.request("check the server health")

server.kill()
```

### Stream build output

```ts
const build = process.spawn("bun run build --watch")

for await (const line of build.watch(/compiled/)) {
    console.log("Build:", line)
}
```

### Run a process and inspect failures

```ts
const proc = process.spawn("bun test --reporter=verbose")
const { ok } = await proc.exited

if (!ok) {
    const failures = proc.query({ search: "FAIL", context: 5 })
    for (const match of failures.matches) {
        console.log(match.text)
        console.log(match.after.join("\n"))
    }
}
```

For commands where you just need the complete output, use
[process.run](/docs/v2/api/proc/run) instead.
