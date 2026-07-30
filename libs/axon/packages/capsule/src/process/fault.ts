import type { AxonErrorJSON, AxonErrorSeverity } from "@arcforge/types"

/**
 * The guest's error builder — produces the AxonErrorJSON wire shape WITHOUT
 * importing @arcforge/err.
 *
 * Everything under src/process/ runs inside the confined sandbox, whose
 * filesystem is exactly what the fs policy declares and nothing more. A
 * workspace package resolves through a symlink that points OUT of the box
 * (node_modules/@arcforge/err -> ../../../err), so importing the real err()
 * here makes the subprocess die at startup with ENOENT — which is
 * confinement working as designed, not a packaging bug. This is why guest
 * code imports only node builtins and `type`-only declarations, which erase
 * at compile time and never hit the module resolver.
 *
 * So the guest builds the same shape by hand. The result is a faithful
 * AxonErrorJSON: same discriminant, same identifying fields, the raw stack
 * preserved, and the cause captured — everything a reader needs off the
 * durable log. What it deliberately does NOT do is duplicate the error map:
 * `code`, `title` and `description` are supplied by the call site, so this
 * file never drifts out of sync with a registry it cannot see.
 *
 * `frames` is always empty. Structured frame capture belongs to err()'s
 * stack parser, which reads source files off disk to attach snippets —
 * exactly the kind of filesystem reach confinement exists to prevent. The
 * raw `stack` string still crosses, so nothing about where it threw is
 * lost; only the pre-parsed presentation is.
 */
export function fault(opts: {
    code: string
    title: string
    description: string
    message: string
    severity?: AxonErrorSeverity
    context?: Record<string, unknown>
    cause?: unknown
}): AxonErrorJSON {
    const cause = opts.cause

    return {
        isAxonError: true,
        code: opts.code,
        title: opts.title,
        description: opts.description,
        message: opts.message,
        source: "capsule",
        severity: opts.severity ?? "degraded",
        ...(opts.context ? { context: opts.context } : {}),
        frames: [],
        ...(cause instanceof Error && cause.stack ? { stack: cause.stack } : {}),
        ...(cause !== undefined ? { cause: describeCause(cause) } : {}),
    }
}

/** The cause chain's leaf, in AxonErrorJSON's own `cause` shape. */
function describeCause(cause: unknown): AxonErrorJSON["cause"] {
    if (cause instanceof Error) {
        return {
            message: cause.message,
            ...(cause.stack ? { stack: cause.stack } : {}),
        }
    }
    return String(cause)
}

/**
 * The guest's slice of the error map, inlined for the reason above. Each
 * entry mirrors its @arcforge/err counterpart — keep them in step; the
 * codes are the join key a reader uses across both sides of the pipe.
 */
export const FAULTS = {
    CAPSULE_CMD_FAILED: {
        code: "AX-CAPSULE-018",
        title: "Capsule Command Failed",
        description: "Code executed in the sandbox threw. This is the ordinary failure path for an agent-emitted block or a script-land run() — the error is the sandboxed code's own, surfaced verbatim.",
    },
    CAPSULE_FN_FAILED: {
        code: "AX-CAPSULE-019",
        title: "Tool Call Threw",
        description: "A mediated tool function threw inside the sandbox. The failure is the tool's own; it propagates to the calling code unchanged and is recorded as the closing half of the call's span.",
    },
    CAPSULE_TOOL_FAILED: {
        code: "AX-CAPSULE-003",
        title: "Tool Failed To Load",
        description: "A tool module threw while being imported into the sandbox. Its namespace is not installed, so every call against it fails.",
    },
    CAPSULE_PROC_DENIED: {
        code: "AX-CAPSULE-020",
        title: "Process Spawn Denied",
        description: "A process the sandbox tried to start was refused — denied by policy, killed before it could spawn, or the spawn itself failed. No process was created.",
    },
    CAPSULE_PROC_FAILED: {
        code: "AX-CAPSULE-022",
        title: "Managed Process Failed",
        description: "A spawned child process errored without ever producing an exit code — an exec failure or a broken IPC channel. Distinct from a non-zero exit, which is the process running correctly and reporting a result.",
    },
    CAPSULE_PROC_STDIN_FAILED: {
        code: "AX-CAPSULE-021",
        title: "Process Stdin Write Failed",
        description: "Writing to a managed child process's stdin failed — the process is no longer running, or its stdin has already closed.",
    },
    CAPSULE_CRASHED: {
        code: "AX-CAPSULE-015",
        title: "Capsule Crashed",
        description: "An unhandled error escaped inside the sandbox subprocess. The capsule reports it on the wire and exits immediately — after an unhandled throw the sandbox's state is unknown, and a capsule that keeps serving is worse than one that dies loudly.",
    },
} as const satisfies Record<string, { code: string; title: string; description: string }>

/** Build a fault from the inlined map — the guest's equivalent of err(code, opts). */
export function capsuleFault(
    name: keyof typeof FAULTS,
    opts: { message: string; severity?: AxonErrorSeverity; context?: Record<string, unknown>; cause?: unknown },
): AxonErrorJSON {
    return fault({ ...FAULTS[name], ...opts })
}
