---
title: process
---

# process

Scripts run inside the capsule subprocess and have direct access to the global `process`
object. Axon extends it with two methods for shell execution:

```ts
interface AgentProcess extends NodeJS.Process {
    // Blocking — run a command and await the full result. Never throws.
    run(
        command: string,
        opts?: { cwd?: string; env?: Record<string, string>; input?: string }
    ): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; err?: string }>

    // Detached — returns a LiveProcHandle immediately. Tracked in AIR <processes>.
    spawn(
        command: string,
        opts?: { cwd?: string; env?: Record<string, string> }
    ): LiveProcHandle

    // Blocked — the capsule manages its own lifecycle
    exit: never
}
```

Everything else is unchanged: `process.env`, `process.cwd()`, `process.platform`,
`process.pid`, `process.argv`.

Both `run` and `spawn` are gated by the capsule policy. If `policy.proc` is `false` or
the command doesn't match an allow list, the call is blocked before execution and a
`capsule:proc:denied` event is emitted.

```ts
// blocking
const result = await process.run("bun test")

// detached
const server = process.spawn("bun dev")
await server.waitFor("ready on port")
server.kill()
```
