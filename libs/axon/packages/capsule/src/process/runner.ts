import { capsuleFault } from "./fault"
import { since, snapshot } from "./bindings"
import type { CapsuleCommand, CapsuleCommandOrigin } from "../../types"
import type { ConsoleT } from "./console"
import type { ScopeT } from "./scope"
import type { SandboxWireT } from "./wire"
import type { ExecutionT } from "./execution"
import type { ActivitiesT } from "./activities"

type RunnerOpts = {
    scope: ScopeT
    wire: SandboxWireT
    console: ConsoleT
    execution: ExecutionT
    activities: ActivitiesT
}

/**
 * Runner — executes genuine TypeScript with Bun's native REPL transform.
 * replMode is the structural owner of the semantics AIR promises: it strips
 * types, supports top-level await, hoists declarations so runtime values
 * survive later submissions, and captures the final expression as the
 * submission's completion value. We do not maintain a second hand-written
 * parser or source rewriter alongside Bun's TypeScript grammar.
 *
 * This subprocess IS the persistent state. Compiled submissions execute by
 * indirect eval against its real global object; there is no VM facade or
 * snapshot/restore layer between the agent and its process.
 *
 * Process boundary is the real isolation; this does not attempt to
 * hard-kill a running eval — cmd:kill sets globalThis.signal, which
 * mediated tool calls observe cooperatively (a tight synchronous loop
 * cannot be interrupted without a second OS process, which the design
 * deliberately avoids).
 *
 * This is the only TS-eval path in the capsule. process.run()/process.spawn()
 * are a different primitive entirely — shelling out to bash — and live in
 * SandboxProcs, not here.
 */

/**
 * Insert the semicolon ASI will not.
 *
 * A line starting with `(` or `[` continues the previous one — JavaScript
 * reads it as a call or an index, never as a new statement. That is a
 * well-known footgun, and this REPL walks straight into it because the
 * contract teaches ending a block with a bare expression:
 *
 * ```ts
 * const [a, b] = await Promise.all([…])
 * ({ a, b })                              // ← calls the array
 * ```
 *
 * A real run produced exactly that and got back
 * `Promise.all([…]) is not a function`, which names nothing the model did
 * wrong and nothing it can act on. Models write this shape constantly because
 * `({ … })` is the idiomatic way to return an object literal as a completion
 * value.
 *
 * Only a line whose FIRST character is `(` or `[` is touched, and only when
 * the previous non-blank line does not already end in a separator — so
 * genuine continuations (a multi-line call, a chained index) are untouched.
 * Inside a template literal nothing is rewritten, since a newline there is
 * data rather than syntax.
 */
export function guardAsi(code: string): string {
    const lines = code.split("\n")
    let backticks = 0
    const out: string[] = []

    for (const line of lines) {
        const trimmed = line.trimStart()
        const previous = [...out].reverse().find(l => l.trim().length > 0)
        const openInTemplate = backticks % 2 === 1

        if (
            !openInTemplate
            && previous !== undefined
            && /^[([]/.test(trimmed)
            && !/[;,({[+\-*/%&|^<>=?:]$/.test(previous.trimEnd())
        ) {
            out.push(`;${line}`)
        } else {
            out.push(line)
        }

        // Escaped backticks do not open or close a template.
        backticks += (line.match(/(?<!\\)`/g) ?? []).length
    }

    return out.join("\n")
}



/**
 * Undo Bun's Latin-1 reading of a UTF-8 source line.
 *
 * `BuildMessage.position.lineText` arrives byte-per-character, so a line
 * containing anything non-ASCII comes back as mojibake (`彩票` → `å½©ç¥¨`).
 * Quoting that straight back would hand the model corrupted text as its
 * example of what to fix — and the lines that trip this are precisely the ones
 * carrying stray non-ASCII, so it is the common case rather than the rare one.
 *
 * Falls back to the original when the bytes do not decode, which is what
 * happens for a line that was genuinely Latin-1 or already correct.
 */
function repairMojibake(text: string): string {
    if (!/[\u0080-\u00ff]/.test(text)) return text
    try {
        const bytes = Uint8Array.from([...text].map(c => c.charCodeAt(0) & 0xff))
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
        return text
    }
}

/**
 * A failure, as the model has to read it.
 *
 * A syntax error from `Bun.Transpiler` is an `AggregateError` whose own
 * `message` is the bare string `"Parse error"` — the line, the column and the
 * offending text all live in `.errors`, which was discarded. So a model that
 * corrupted ONE line of an otherwise-correct 3.6k script was told only
 * "Parse error", four times running, with nothing to act on.
 *
 * That case is real and not hypothetical: models intermittently emit a
 * corrupted preamble line (`tagger to=fs.edit …` followed by junk) ahead of
 * valid code. We cannot stop them producing it, but we can say WHICH line
 * failed, so the next attempt rewrites that line instead of guessing.
 */
export function describeFailure(cause: unknown): string {
    const errors = (cause as { errors?: unknown }).errors
    if (!Array.isArray(errors) || errors.length === 0) {
        return cause instanceof Error ? cause.message : String(cause)
    }

    // Only the first few: a single bad line cascades into a dozen follow-on
    // errors, and after the first the parser is guessing.
    const lines = errors.slice(0, 3).map(error => {
        const e = error as { message?: string; position?: { line?: number; column?: number; lineText?: string } }
        const at = e.position?.line !== undefined ? `line ${e.position.line}` : ""
        const text = repairMojibake(e.position?.lineText ?? "").trim()
        return [at, e.message].filter(Boolean).join(": ") + (text ? `\n    ${text}` : "")
    })

    const more = errors.length > 3 ? [`... and ${errors.length - 3} more`] : []
    return [cause instanceof Error ? cause.message : "Parse error", ...lines, ...more].join("\n")
}

export function Runner(opts: RunnerOpts) {
    const { scope, wire, console: sandboxConsole, execution, activities } = opts
    const aborts = new Map<string, AbortController>()
    const g = globalThis as Record<string, unknown>
    const transpiler = new Bun.Transpiler({
        loader: "ts",
        target: "bun",
        replMode: true,
    })

    /**
     * Bun replMode boxes a final expression so it survives transpilation.
     *
     * The unboxed value is AWAITED by the caller, because a trailing
     * expression is very often a promise: `Promise.all([...])` as the last
     * line, or a bare `fs.read(...)` without `await`. Returning the promise
     * object itself put `{}` in front of the model where it expected data,
     * which reads as a tool that silently did nothing.
     */
    function completionValue(value: unknown): unknown {
        if (
            typeof value === "object"
            && value !== null
            && Object.getPrototypeOf(value) === null
            && Object.prototype.hasOwnProperty.call(value, "value")
        ) {
            return (value as { value: unknown }).value
        }
        return value
    }

    // Unlike a mutable global value, this getter resolves through the async
    // chain of the calling command, so concurrent evaluations see their own
    // cancellation signal.
    Object.defineProperty(g, "signal", {
        configurable: true,
        get: () => execution.current?.signal,
    })

    /**
     * Tool namespaces attach to globalThis once, on load — the same
     * persistent object user code's own vars live on. Returns the names so
     * scope extraction can exclude them: they land on globalThis during this
     * very run, and would otherwise read as bindings the submission declared.
     */
    function syncToolGlobals(): string[] {
        const globals = scope.globals()
        for (const [name, value] of Object.entries(globals)) {
            g[name] = value
        }
        return Object.keys(globals)
    }

    /**
     * Announce the working directory whenever a command moved it.
     *
     * The declared contract is "cwd changes persist across blocks", which is
     * only true within one incarnation — a reload starts a fresh process at
     * whatever cwd it was configured with. Reporting the change as it happens
     * lets the host track cwd continuously, instead of interrogating a dying
     * sandbox for its last known location at reload time.
     */
    let lastCwd = process.cwd()
    function reportCwd(): void {
        const cwd = process.cwd()
        if (cwd === lastCwd) return
        lastCwd = cwd
        wire.emit("capsule:cwd", { cwd })
    }

    async function run(id: string, code: string, origin?: CapsuleCommandOrigin): Promise<void> {
        const startedAt = Date.now()
        const controller = new AbortController()
        aborts.set(id, controller)

        // Provenance travels with the span that opens, so every reader of
        // the log sees it at the same place. Omitted when absent rather
        // than defaulted to "cognet" here — the type already says absent
        // means cognet, and writing it would bloat every ordinary command.
        wire.emit("capsule:cmd:start", { id, ...(origin ? { origin } : {}) })

        const toolNames = syncToolGlobals()
        // Taken AFTER tool globals land so they are already part of the
        // baseline, and before the eval so the diff is exactly this
        // submission's own declarations.
        const before = snapshot()

        try {
            const prepared = transpiler.transformSync(guardAsi(code))

            // Indirect eval runs against globalThis. Bun replMode supplies
            // its own sync/async wrapper and hoists declarations outside it;
            // awaiting handles both forms without changing their semantics.
            const indirectEval: typeof eval = eval
            const result = await execution.run(id, controller.signal, () =>
                sandboxConsole.run(id, async () => await completionValue(await indirectEval(prepared))),
            )
            // Activities the script left open settle BEFORE the command does —
            // the wire (and every fold downstream) reads: rows close, then the run closes.
            activities.settle(id)
            wire.emit("capsule:cmd:complete", {
                id,
                result,
                scope: since(before, toolNames),
                durationMs: Date.now() - startedAt,
            })
        } catch (cause) {
            const message = describeFailure(cause)
            if (controller.signal.aborted) {
                activities.settle(id, "interrupted")
                wire.emit("capsule:cmd:interrupted", { id, durationMs: Date.now() - startedAt })
            } else {
                // The activity row carries the bare message — it is a render
                // hint for a UI row, not a diagnostic. The event carries the
                // full structured error.
                activities.settle(id, message)
                wire.emit("capsule:cmd:failed", {
                    id,
                    error: capsuleFault("CAPSULE_CMD_FAILED", { message, context: { commandId: id }, cause }),
                    durationMs: Date.now() - startedAt,
                })
            }
        } finally {
            aborts.delete(id)
            // After the command settles, however it settled — code that
            // chdir'd and then threw still moved the process.
            reportCwd()
        }
    }

    wire.onCommand((cmd: CapsuleCommand) => {
        if (cmd.type === "cmd:run") {
            void run(cmd.id, cmd.code, cmd.origin)
        } else if (cmd.type === "cmd:kill") {
            aborts.get(cmd.id)?.abort()
        }
    })

    return {}
}

export type RunnerT = ReturnType<typeof Runner>
