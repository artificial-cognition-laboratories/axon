import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import type { CapsuleScope } from "@arcforge/types"
import type { CapsuleCommand, CapsuleCommandOrigin } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

/**
 * What one successful execution produced: its completion value, and the
 * bindings it left in the sandbox. The scope is what a rendered template
 * interpolates against; callers that only want the value ignore it.
 */
export type CapsuleExecResult = {
    value: unknown
    scope: CapsuleScope
}

type ExecOpts = {
    send(cmd: CapsuleCommand): void
    bus: CapsuleBusT
    /** Replace the sandbox incarnation when cooperative cancellation stalls. */
    hardInterrupt(): Promise<void>
}

type RunOpts = {
    /**
     * Command id — every capsule:cmd/fn/activity/console event this run
     * produces carries it. Callers that already minted an id for this
     * execution (the kernel's cognet:action:typescript entry) pass it here
     * so the whole span tree shares ONE id instead of two ids for the
     * same run. Generated when absent.
     */
    id?: string
    /** Max ms for the command. Default 300_000. */
    timeout?: number
    /** Abort the run — kills the command in the subprocess. */
    signal?: AbortSignal
    /** Called for every console.* call made by this specific run, in order — never other concurrent runs'. */
    onConsole?: (level: "log" | "info" | "warn" | "error" | "debug", args: unknown[]) => void
    /**
     * Who asked for this code to run. Defaults to "cognet" — the agent's
     * own reasoning, which is every command the runtime issues.
     *
     * "host" is a developer executing code directly against a live capsule
     * (Fleet's capsule input). It is the SAME execution path under the SAME
     * policy gate — the distinction is provenance, not privilege — but a
     * reader of the session log must be able to tell the two apart, or the
     * record claims the agent did something a human did.
     */
    origin?: CapsuleCommandOrigin
}

/**
 * Exec — the code-execution conversation. One sentence: sends cmd:run and
 * correlates the reply.
 *
 * Pure protocol client: depends on { send, bus } only, holds per-command
 * state only. Rejects on cmd:failed, timeout, abort, or restart (a swap
 * mid-run means the command died with its incarnation — reject immediately,
 * never hang until timeout).
 */
export function Exec(opts: ExecOpts) {
    const { send, bus } = opts
    const graceMs = 250

    /**
     * Every in-flight command, by id.
     *
     * The subprocess dispatches commands CONCURRENTLY — its wire handler is
     * `void run(cmd.id, cmd.code)`, with no queue — so the host must track
     * them the same way. A single slot silently lost the previous command's
     * abort handle the moment a second one started: interrupt() would abort
     * only the newest, and the older command became unabortable for the rest
     * of its life. That was invisible while the kernel was the only caller
     * (it runs one at a time), and became reachable the moment a developer
     * could execute code against a live capsule.
     */
    const active = new Map<string, () => void>()

    function exec(code: string, runOpts: RunOpts = {}): Promise<CapsuleExecResult> {
        const id = runOpts.id ?? randomUUID()
        const timeoutMs = runOpts.timeout ?? 300_000

        if (runOpts.signal?.aborted) {
            const error = new Error("capsule run aborted")
            error.name = "AbortError"
            return Promise.reject(error)
        }

        return new Promise<CapsuleExecResult>((resolve, reject) => {
            const offs: Array<() => void> = []
            let cancelling: "abort" | "timeout" | null = null
            let graceTimer: ReturnType<typeof setTimeout> | null = null

            function settle(fn: () => void) {
                for (const off of offs) off()
                clearTimeout(timeoutTimer)
                if (graceTimer) clearTimeout(graceTimer)
                runOpts.signal?.removeEventListener("abort", onAbort)
                active.delete(id)
                fn()
            }

            const cancellationError = () => {
                const error = new Error(cancelling === "timeout"
                    ? `capsule run timed out after ${timeoutMs}ms`
                    : "capsule run aborted")
                if (cancelling === "abort") error.name = "AbortError"
                return error
            }

            function cancel(reason: "abort" | "timeout") {
                if (cancelling) return
                cancelling = reason
                bus.emit("capsule:cmd:interrupt:requested", { id, reason })
                try {
                    send({ type: "cmd:kill", id })
                } catch {
                    // The hard path below owns recovery from a broken wire.
                }
                graceTimer = setTimeout(() => {
                    void opts.hardInterrupt()
                        .then(() => {
                            bus.emit("capsule:cmd:hard-killed", { id, graceMs })
                            settle(() => reject(cancellationError()))
                        })
                        .catch(err => settle(() => reject(err)))
                }, graceMs)
            }

            const timeoutTimer = setTimeout(() => cancel("timeout"), timeoutMs)

            function onAbort() {
                cancel("abort")
            }

            offs.push(
                bus.on("capsule:cmd:complete", e => {
                    if (e.id !== id) return
                    if (cancelling) settle(() => reject(cancellationError()))
                    else settle(() => resolve({ value: e.result, scope: e.scope }))
                }),
                bus.on("capsule:cmd:failed", e => {
                    if (e.id !== id) return
                    // The sandbox's error arrives as plain data (it crossed a
                    // process boundary). Rebuild it host-side so the caller
                    // gets a real throwable carrying the guest's own message
                    // and structured cause, not "[object Object]".
                    settle(() => reject(cancelling
                        ? cancellationError()
                        : err("CAPSULE_CMD_FAILED", { detail: e.error.message, context: { commandId: id }, cause: e.error })))
                }),
                bus.on("capsule:cmd:interrupted", e => {
                    if (e.id !== id) return
                    settle(() => reject(cancellationError()))
                }),
                // The incarnation died mid-run — the command died with it.
                bus.on("capsule:exit", () => {
                    if (cancelling) return
                    settle(() => reject(new Error("capsule exited during run")))
                }),
                bus.on("capsule:console", e => {
                    if (e.commandId !== id) return
                    runOpts.onConsole?.(e.level, e.args)
                }),
            )

            active.set(id, onAbort)

            if (runOpts.signal?.aborted) {
                onAbort()
                return
            }
            runOpts.signal?.addEventListener("abort", onAbort, { once: true })

            // Send last — everything is listening before the subprocess can reply.
            send({ type: "cmd:run", id, code, ...(runOpts.origin ? { origin: runOpts.origin } : {}) })
        })
    }

    return {
        /**
         * Run code and return its completion value — the long-standing
         * surface, unchanged. Most callers want a value and nothing else.
         */
        run(code: string, runOpts: RunOpts = {}): Promise<unknown> {
            return exec(code, runOpts).then(r => r.value)
        },

        /**
         * Run code and return its completion value AND the bindings it left
         * behind. Separate from run() because the scope is only meaningful to
         * a caller that is about to render a template against it; every other
         * caller would have to unwrap a field it never reads.
         */
        exec,

        /**
         * Abort a run. With an id, that one command; without, every
         * in-flight command — which is what a caller with no id can mean
         * now that several can be running at once.
         */
        interrupt(id?: string) {
            if (id !== undefined) {
                active.get(id)?.()
                return
            }
            for (const abort of [...active.values()]) abort()
        },
    }
}

export type ExecT = ReturnType<typeof Exec>
