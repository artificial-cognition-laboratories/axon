import type { AxonTestEvent } from "@arcforge/types"

export type TestRunOptions = {
    files: string | string[]
    cwd?: string
    env?: Record<string, string | undefined>
    timeoutMs?: number
    signal?: AbortSignal
    /** Called synchronously in authoritative event order. */
    onEvent?: (event: AxonTestEvent) => void | Promise<void>
    /** Additional child preloads. Test instrumentation always loads first. */
    preloads?: string[]
    /** Domain extensions may consume their own validated IPC channels. */
    onMessage?: (message: unknown) => void | Promise<void>
}

export type TestRunResult = {
    runId: string
    status: "passed" | "failed" | "cancelled"
    exitCode: number | null
    durationMs: number
    files: string[]
    events: AxonTestEvent[]
    stdout: string
    stderr: string
}
