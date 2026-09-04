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
    readonly status: "pending" | "running" | "exited"
    readonly exitCode: number | undefined
    readonly startedAt: number
    readonly endedAt: number | undefined
    kill(): void
    stdin(data: string): void
    stdout(include?: ProcOutputStream | ProcOutputStream[]): string
    tail(lines: number, include?: ProcOutputStream[]): string
    query(opts?: ProcQueryOptions): ProcQuerySnapshot
    extract(regex: RegExp, include?: ProcOutputStream[]): string[]
    readonly started: Promise<{ ok: boolean; pid: number | undefined; err: string | undefined }>
    readonly exited: Promise<{ exitCode: number; ok: boolean; stdout: string }>
    waitFor(pattern: string | RegExp, opts?: { timeoutMs?: number }): Promise<{ line: string; stdout: string }>
    on(match: string | RegExp, cb: (line: string) => void): () => void
    watch(match?: string | RegExp): AsyncGenerator<string, void, unknown>
}`,
        `type CapsuleProcess = NodeJS.Process & {
    run(command: string, opts?: ProcRunOptions): Promise<ProcRunResult>
    spawn(command: string, opts?: ProcSpawnOptions): LiveProcHandle
    procs(): LiveProcHandle[]
    proc(procId: string): LiveProcHandle | undefined
}`,
    ],
    members: [
        {
            name: "process",
            declaration: "const process: CapsuleProcess",
            jsdoc: `Your native, persistent Bun/Node-compatible process object.
Executable blocks live in this process, so standard APIs such as cwd(), chdir(), env, argv, pid, timing, resources, and process events are available without being enumerated here. Runtime state and cwd changes persist across blocks. Axon adds run(), spawn(), procs() and proc(); Axon manages process lifecycle and redirects protocol stdio, so those members have capsule-specific behavior.

spawn() returns IMMEDIATELY, before the process has actually launched, so the handle starts at status "pending" with no pid. Await handle.started to find out whether it launched — it resolves { ok, pid, err } once the spawn settles, and ok:false carries the reason it was refused. Do not infer failure from a missing pid on a freshly returned handle, and do not await handle.exited to confirm a background process started: exited only resolves when it dies, which for ambient work is never.

Spawned processes OUTLIVE the block that created them. Use procs() to see every process this agent owns, and proc(procId) to recover a handle in a later block.`,
        },
        {
            name: "signal",
            declaration: "const signal: AbortSignal",
            jsdoc: "Abort signal for the current TypeScript execution.",
        },
    ],
}
