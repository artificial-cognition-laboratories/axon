export type ProcOutputStream = "stdout" | "stderr"

/**
 * Result of `process.run()` — a blocking, inline shell command. Never thrown;
 * a failed command is a normal result with `ok: false`. `err` is only set
 * when the command couldn't even be attempted (denied by policy, spawn
 * failed) — a non-zero exit from a command that did run is not an `err`,
 * just `ok: false` with the real `exitCode`.
 */
export type ProcRunResult = {
    ok: boolean
    exitCode: number
    stdout: string
    stderr: string
    err?: string
}

export type ProcRunOptions = {
    cwd?: string
    env?: Record<string, string>
    input?: string
}

export type ProcSpawnOptions = {
    cwd?: string
    env?: Record<string, string>
}

export type ProcQueryOptions = {
    /** Substring to find in buffered output. */
    search?: string
    /** Regular expression to match against buffered output. */
    regex?: RegExp
    /** Exclude lines containing this substring. */
    not?: string
    /** Maximum number of buffered lines to consider. */
    lines?: number
    /** Return only the first N lines before matching. */
    head?: number
    /** Start line offset, zero-based. */
    from?: number
    /** End line offset, exclusive. */
    to?: number
    /** Number of lines to include before and after each match. */
    context?: number
    /** Which output streams to include. Defaults to stdout. */
    include?: ProcOutputStream[]
    /** Whether substring matching should preserve case. Defaults to false. */
    caseSensitive?: boolean
}

/** A single match returned by `LiveProcHandle.query()`. */
export type ProcQueryMatch = {
    line: number
    text: string
    before: string[]
    after: string[]
}

/** Snapshot returned by `LiveProcHandle.query()`. */
export type ProcQuerySnapshot = {
    procId: string
    lines: string[]
    raw: string
    matches: ProcQueryMatch[]
    totalLines: number
    matchedLines: number
    stream: "stdout" | "stderr" | "both"
}

/**
 * Live handle returned by `process.spawn()` for a tracked subprocess.
 *
 * The command runs in the background while the capsule captures stdout, stderr,
 * status, exit code, and lifecycle timestamps. Use this for servers, watchers,
 * long-running builds, and commands whose output you need to inspect while they
 * are still running.
 *
 * ```ts
 * const server = process.spawn("bun dev")
 * await server.waitFor("ready", { timeoutMs: 15_000 })
 *
 * const failures = server.query({ search: "ERROR", context: 3 })
 * server.kill()
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/api/proc/spawn
 */
/**
 * Where a managed child is in its lifecycle.
 *
 * `pending` is the window a spawn is REAL but unverified: `spawn()` returns
 * synchronously (the ergonomics of `const p = process.spawn(...)` depend on
 * it) while mediation and the OS spawn happen behind it. During that window
 * there is no pid and no verdict, and saying "running" would be a claim
 * nobody made — a denied spawn and a still-launching one looked identical,
 * which is precisely how a live process got reported as one that died.
 *
 * A caller that wants the settled answer awaits `started`; a caller that
 * wants the terminal one awaits `exited`.
 */
export type ProcStatus = "pending" | "running" | "exited"

export interface LiveProcHandle {
    /** Stable process ID assigned by the capsule. */
    readonly procId: string
    /** Managed background process, or an observable blocking process.run. */
    readonly kind: "managed" | "run"
    /** Original shell command. */
    readonly command: string
    /** Operating-system process ID, if the process has started. */
    readonly pid: number | undefined
    /** Working directory used to spawn the command. */
    readonly cwd: string | undefined
    /**
     * Current lifecycle status. `pending` until the spawn is mediated and the
     * OS reports a pid — read `started` rather than polling this.
     */
    readonly status: ProcStatus
    /** Exit code after completion. Undefined while running. */
    readonly exitCode: number | undefined
    /** Unix timestamp in milliseconds when the process was spawned. */
    readonly startedAt: number
    /** Unix timestamp in milliseconds when the process exited. */
    readonly endedAt: number | undefined
    /** Terminate the process. No-op if it has already exited. */
    kill(): void
    /** Write a string to the process stdin. */
    stdin(data: string): void
    /** Return buffered output for the selected stream(s). Defaults to stdout. */
    stdout(include?: ProcOutputStream | ProcOutputStream[]): string
    /** Return the last N lines from the selected streams. */
    tail(lines: number, include?: ProcOutputStream[]): string
    /** Query buffered output for substring or regex matches with optional context. */
    query(opts?: ProcQueryOptions): ProcQuerySnapshot
    /** Extract all regex matches from buffered output. */
    extract(regex: RegExp, include?: ProcOutputStream[]): string[]
    /**
     * Resolves once the spawn has SETTLED — mediated, and either launched with
     * a real pid or refused. It does not wait for the process to finish.
     *
     * This is what makes `pending` a state a caller can leave rather than
     * merely observe. Awaiting it is the difference between "I asked for a
     * process" and "there is a process": without it, the only settled signal
     * was `exited`, so the sole way to confirm a spawn worked was to wait for
     * it to die — useless for exactly the long-lived background work spawn()
     * exists to start.
     */
    readonly started: Promise<{ ok: boolean; pid: number | undefined; err: string | undefined }>
    /** Resolves once the process exits. */
    readonly exited: Promise<{ exitCode: number; ok: boolean; stdout: string }>
    /** Resolves when a buffered or future line matches the pattern. */
    waitFor(pattern: string | RegExp, opts?: { timeoutMs?: number }): Promise<{ line: string; stdout: string }>
    /** Subscribe to future matching lines. Returns an unsubscribe function. */
    on(match: string | RegExp, cb: (line: string) => void): () => void
    /** Async generator of lines. Unfiltered when match is omitted. */
    watch(match?: string | RegExp): AsyncGenerator<string, void, unknown>
}
