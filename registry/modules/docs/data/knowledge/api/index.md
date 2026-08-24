---
title: axon
---

# axon

The `axon` global is available in every script and tool. It is the runtime interface
between your code and the agent loop — send tasks, load prompts, invoke scripts, call
tools, request input from the TUI.

```ts
interface AxonHandle {
    // Send a prompt and await the full result
    request(prompt: AxonPromptInput): Promise<AxonResult>
    request(opts: { prompt: AxonPromptInput; policy?: PolicyPatch }): Promise<AxonResult>

    // Send a prompt and stream entries as they arrive
    stream(prompt: AxonPromptInput): { stream: AsyncGenerator<AnyThreadEntry> }
    stream(opts: { prompt: AxonPromptInput; policy?: PolicyPatch }): { stream: AsyncGenerator<AnyThreadEntry> }

    // Load and render a prompt file
    prompt(name: string, vars?: Record<string, unknown>): Promise<AxonRenderedPrompt>

    // Invoke another script
    scripts: {
        request(name: string, args?: Record<string, unknown>): Promise<AxonResult>
        stream(name: string, args?: Record<string, unknown>): { stream: AsyncGenerator<AnyThreadEntry> }
    }

    // Call installed tool functions by namespace
    tools: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>

    // Request input from a connected TUI host
    ui: {
        ask(opts: { message: string; options: string[]; timeout?: number }): Promise<
            | { selected: string }
            | { timeout: true }
            | { unavailable: true }
        >
    }

    // Subscribe to lifecycle events
    hooks: {
        on(event: string, handler: (payload: unknown) => void): () => void
        callHook(event: string, payload?: unknown): Promise<void>
    }

    // Query engine capabilities
    capabilities(): { text: boolean; audio: boolean; image: boolean }
}
```

`axon` is always scoped to the running agent instance. There is no cross-agent access.

## process

Scripts also have direct access to the extended `process` global:

```ts
interface AgentProcess extends NodeJS.Process {
    // Blocking — run a command and await the full result. Never throws.
    run(
        command: string,
        opts?: { cwd?: string; env?: Record<string, string>; input?: string }
    ): Promise<{ ok: boolean; exitCode: number; stdout: string; stderr: string; err?: string }>

    // Detached — returns a LiveProcHandle immediately
    spawn(
        command: string,
        opts?: { cwd?: string; env?: Record<string, string> }
    ): LiveProcHandle

    // Blocked — the capsule manages its own lifecycle
    exit: never
}
```

`process.env` contains every key from the agent's `.env` and `axon.config.ts` env
configuration. `process.cwd()`, `process.platform`, `process.pid` are unchanged.

See [process.run()](/docs/v2/api/proc/run), [process.spawn()](/docs/v2/api/proc/spawn),
and [process.env](/docs/v2/api/proc/env) for the full reference.
