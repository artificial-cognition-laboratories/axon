/**
 * The AxonError wire contract.
 *
 * Lives in @arcforge/types because AxonError is a payload shape carried by
 * failure events across every layer (runtime, cognet, test, bench) — it is a
 * contract, not behavior. @axon/err owns the *runtime* (the err() constructor,
 * stack capture, rendering, bus emission) and imports these types from here to
 * implement them. Types owns the shape; err owns the behavior.
 *
 * Runtime-derived types stay in @axon/err: AxonErrorCode / AxonErrorMap are
 * `keyof`/`typeof` over the concrete error map and cannot exist without it.
 */

/** One line of captured source around a stack frame. */
export type AxonSourceLine = {
    lineNumber: number
    text: string
}

/** A single structured stack frame, captured at error construction time. */
export type AxonStackFrame = {
    functionName: string | null
    fileName: string | null
    lineNumber: number | null
    columnNumber: number | null
    /** Lines of source around lineNumber, captured at construction time. Null when the file wasn't reachable on disk. */
    source: AxonSourceLine[] | null
}

/** Which subsystem an error originates from. */
export type AxonErrorSource =
    | "runtime" | "manifest" | "capsule" | "server" | "thread" | "cli"
    | "cloud" | "kernel" | "cognet" | "tui" | "bench"
    // The machine-wide daemon. Its own source rather than "runtime": a
    // failure here is about SHARED state — the GPU, the instance registry —
    // and telling that apart from one agent's runtime fault is the difference
    // between "restart your agent" and "start the daemon".
    | "daemon"

/** Lifecycle impact of an error. */
export type AxonErrorSeverity = "fatal" | "recovered" | "degraded"

/**
 * Context every error code can carry — free-form per code. Deliberately
 * Record<string, unknown> rather than one shape per code.
 */
export type AxonErrorContext = Record<string, unknown>

/**
 * The plain-data shape AxonError.toJSON() produces — what lands in the session
 * JSONL and on the bus. AxonError IS the wire shape; there is no separate
 * compact projection.
 */
export type AxonErrorJSON = {
    isAxonError: true
    code: string
    title: string
    description: string
    message: string
    source: AxonErrorSource
    severity: AxonErrorSeverity
    context?: AxonErrorContext
    frames: AxonStackFrame[]
    stack?: string
    /**
     * best-effort — a real Error's own message/stack, or String(cause) for
     * anything else. `frame` is the cause's OWN first non-framework stack
     * frame — where the user's code actually threw.
     */
    cause?: { message: string; stack?: string; frame?: AxonStackFrame | null } | string
}

/**
 * The rich, in-process error object. Every AxonError is a real Error plus the
 * full renderable identity: code, title, description, severity, and a
 * structured stack captured at construction time.
 */
export interface AxonError extends Error {
    code: string
    title: string
    description: string
    source: AxonErrorSource
    severity: AxonErrorSeverity
    /**
     * The USER caused this and can fix it from the message alone — a wrong
     * directory, a missing argument, a name that does not exist.
     *
     * Renderers show these without frames or a cause chain: our call stack is
     * not part of the answer, and printing it tells the user to debug software
     * they did not write. Absent means unexpected (the safe default), which
     * still gets the full diagnostic.
     *
     * A different axis from `severity`: PROJECT_NOT_FOUND is both `fatal` (the
     * command cannot continue) and expected.
     */
    expected?: boolean
    context: AxonErrorContext | undefined
    frames: AxonStackFrame[]
    /** native Error.cause — walk this to render the full chain */
    cause?: unknown
    isAxonError: true
    /** The full Rust-style report: title, description, message, every frame, cause chain. */
    render(): string
    /** Plain-data projection — called automatically by JSON.stringify. */
    toJSON(): AxonErrorJSON
}
