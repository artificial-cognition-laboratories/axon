import { capsuleFault } from "./fault"
import type { CapsuleCommand } from "../../types"
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
export function Runner(opts: RunnerOpts) {
    const { scope, wire, console: sandboxConsole, execution, activities } = opts
    const aborts = new Map<string, AbortController>()
    const g = globalThis as Record<string, unknown>
    const transpiler = new Bun.Transpiler({
        loader: "ts",
        target: "bun",
        replMode: true,
    })

    /** Bun replMode boxes a final expression so it survives transpilation. */
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

    /** Tool namespaces attach to globalThis once, on load — the same persistent object user code's own vars live on. */
    function syncToolGlobals(): void {
        for (const [name, value] of Object.entries(scope.globals())) {
            g[name] = value
        }
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

    async function run(id: string, code: string): Promise<void> {
        const startedAt = Date.now()
        const controller = new AbortController()
        aborts.set(id, controller)

        wire.emit("capsule:cmd:start", { id })

        syncToolGlobals()

        try {
            const prepared = transpiler.transformSync(code)

            // Indirect eval runs against globalThis. Bun replMode supplies
            // its own sync/async wrapper and hoists declarations outside it;
            // awaiting handles both forms without changing their semantics.
            const indirectEval: typeof eval = eval
            const result = await execution.run(id, controller.signal, () =>
                sandboxConsole.run(id, async () => completionValue(await indirectEval(prepared))),
            )
            // Activities the script left open settle BEFORE the command does —
            // the wire (and every fold downstream) reads: rows close, then the run closes.
            activities.settle(id)
            wire.emit("capsule:cmd:complete", { id, result, durationMs: Date.now() - startedAt })
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause)
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
            void run(cmd.id, cmd.code)
        } else if (cmd.type === "cmd:kill") {
            aborts.get(cmd.id)?.abort()
        }
    })

    return {}
}

export type RunnerT = ReturnType<typeof Runner>
