import { randomUUID } from "node:crypto"
import type { CapsuleCommand } from "../../types"
import type { CapsuleBusT } from "../../platform/bus"

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

    let active: { id: string; abort: () => void } | null = null

    function run(code: string, runOpts: RunOpts = {}): Promise<unknown> {
        const id = runOpts.id ?? randomUUID()
        const timeoutMs = runOpts.timeout ?? 300_000

        if (runOpts.signal?.aborted) {
            const error = new Error("capsule run aborted")
            error.name = "AbortError"
            return Promise.reject(error)
        }

        return new Promise((resolve, reject) => {
            const offs: Array<() => void> = []
            let cancelling: "abort" | "timeout" | null = null
            let graceTimer: ReturnType<typeof setTimeout> | null = null

            function settle(fn: () => void) {
                for (const off of offs) off()
                clearTimeout(timeoutTimer)
                if (graceTimer) clearTimeout(graceTimer)
                runOpts.signal?.removeEventListener("abort", onAbort)
                if (active?.id === id) active = null
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
                    else settle(() => resolve(e.result))
                }),
                bus.on("capsule:cmd:failed", e => {
                    if (e.id !== id) return
                    settle(() => reject(cancelling ? cancellationError() : new Error(e.error)))
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

            active = { id, abort: onAbort }

            if (runOpts.signal?.aborted) {
                onAbort()
                return
            }
            runOpts.signal?.addEventListener("abort", onAbort, { once: true })

            // Send last — everything is listening before the subprocess can reply.
            send({ type: "cmd:run", id, code })
        })
    }

    return {
        run,

        /** Abort the in-flight run, if any. No-op when idle. */
        interrupt() {
            active?.abort()
        },
    }
}

export type ExecT = ReturnType<typeof Exec>
