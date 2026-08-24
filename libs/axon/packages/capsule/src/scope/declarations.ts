import type { AxonScopeModule } from "@arcforge/types"

/**
 * The capsule-owned globals installed independently of user tools.
 *
 * Native Bun/Node globals do not need to be re-declared exhaustively here.
 * This module tells AIR what the capsule adds and where it deliberately
 * differs from native behavior; NodeJS.Process activates the model's native
 * API knowledge without copying the enormous version-specific interface.
 */
export const CAPSULE_SCOPE_MODULE: AxonScopeModule = {
    name: "capsule",
    description: "Globals provided by the Axon capsule TypeScript runtime.",
    flat: true,
    ambientTypes: [
        `type ProcOutputStream = "stdout" | "stderr"`,
        `type ProcRunResult = {
    ok: boolean
    exitCode: number
    stdout: string
    stderr: string
    err?: string
}`,
        `type ProcRunOptions = {
    cwd?: string
    env?: Record<string, string>
    input?: string
}`,
        `type ProcSpawnOptions = {
    cwd?: string
    env?: Record<string, string>
}`,
        `type ProcQueryOptions = {
    search?: string
    regex?: RegExp
    not?: string
    lines?: number
    head?: number
    from?: number
    to?: number
    context?: number
    include?: ProcOutputStream[]
    caseSensitive?: boolean
}`,
        `type ProcQueryMatch = {
    line: number
    text: string
    before: string[]
    after: string[]
}`,
        `type ProcQuerySnapshot = {
    procId: string
    lines: string[]
    raw: string
    matches: ProcQueryMatch[]
    totalLines: number
    matchedLines: number
    stream: "stdout" | "stderr" | "both"
}`,
        `interface LiveProcHandle {
    readonly procId: string
    readonly kind: "managed" | "run"
    readonly command: string
    readonly pid: number | undefined
    readonly cwd: string | undefined
    readonly status: "running" | "exited"
    readonly exitCode: number | undefined
    readonly startedAt: number
    readonly endedAt: number | undefined
    kill(): void
    stdin(data: string): void
    stdout(include?: ProcOutputStream | ProcOutputStream[]): string
    tail(lines: number, include?: ProcOutputStream[]): string
    query(opts?: ProcQueryOptions): ProcQuerySnapshot
    extract(regex: RegExp, include?: ProcOutputStream[]): string[]
    readonly exited: Promise<{ exitCode: number; ok: boolean; stdout: string }>
    waitFor(pattern: string | RegExp, opts?: { timeoutMs?: number }): Promise<{ line: string; stdout: string }>
    on(match: string | RegExp, cb: (line: string) => void): () => void
    watch(match?: string | RegExp): AsyncGenerator<string, void, unknown>
}`,
        `type CapsuleProcess = NodeJS.Process & {
    run(command: string, opts?: ProcRunOptions): Promise<ProcRunResult>
    spawn(command: string, opts?: ProcSpawnOptions): LiveProcHandle
}`,
    ],
    members: [
        {
            name: "process",
            declaration: "const process: CapsuleProcess",
            jsdoc: `Your native, persistent Bun/Node-compatible process object.
Executable blocks live in this process, so standard APIs such as cwd(), chdir(), env, argv, pid, timing, resources, and process events are available without being enumerated here. Runtime state and cwd changes persist across blocks. Axon adds run() and spawn(); Axon manages process lifecycle and redirects protocol stdio, so those members have capsule-specific behavior.`,
        },
        {
            name: "signal",
            declaration: "const signal: AbortSignal",
            jsdoc: "Abort signal for the current TypeScript execution.",
        },
    ],
}
