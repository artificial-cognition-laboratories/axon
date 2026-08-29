import { randomUUID } from "node:crypto"
import { err } from "@arcforge/err"
import { CapsuleBus } from "../../platform/bus"
import { Blueprint, mergeCapsuleConfig } from "../blueprint"
import type { CapsulePartialConfig } from "../../types"
import { EMPTY_CAPSULE_SCOPE, type CapsuleScope } from "@arcforge/types"
import { CAPSULE_SCOPE_MODULE } from "../scope/declarations"
import { InProcSandbox } from "./capsule"

/**
 * What one successful execution produced: its completion value, and the
 * bindings it left behind. The scope is what a rendered template interpolates
 * against; callers that only want the value ignore it.
 */
export type CapsuleExecResult = {
    value: unknown
    scope: CapsuleScope
}

/**
 * Capsule — the same handle, without the subprocess.
 *
 * Deliberately identical in surface to the subprocess manager it replaces:
 * `run`, `exec`, `interrupt`, `process`, `scope`, `on`, `boot`, `shutdown`.
 * That is what lets the existing suite — 32 of 34 files, 102 constructions —
 * stand as the acceptance criteria for this port rather than being rewritten
 * alongside it. A test that fails now is telling us something real about the
 * move, not about a rewrite.
 *
 * The concept survives; the shape changes. A capsule was never "a subprocess"
 * — it was "the bounded place agent-emitted code runs, under policy, with
 * everything it does on the record". The subprocess was how that was enforced
 * when the boundary sat between the kernel and the code. Now the boundary is
 * the agent process itself, so the same guarantees hold one level out and the
 * inner wire is redundant.
 *
 * ── What changes behaviourally ──────────────────────────────────────────────
 *
 * `interrupt` is cooperative only. Killing a subprocess could stop a tight
 * synchronous loop; nothing in this heap can. Mediated calls observe the
 * signal — which is every await-shaped operation model code actually writes —
 * and a genuine `while(true)` now hangs the agent until the supervisor
 * restarts it. That is a real reduction, and it is the price of deleting the
 * wire.
 */
export function InProcCapsule(input?: CapsulePartialConfig) {
    let blueprint = Blueprint(input)
    const bus = CapsuleBus()
    let sandbox = InProcSandbox({ config: blueprint, bus })
    let booted = false
    /** Submissions currently running — what interrupt() has to reach. */
    const inflight = new Set<string>()
    /** True once shutdown() begins — changes what an in-flight run rejects with. */
    let shuttingDown = false

    /**
     * The model-facing DECLARATIONS — what the agent is told it can call.
     *
     * Not `CapsuleScope`, which is the bindings one submission left behind.
     * Two different things that both got called "scope": this is the
     * `<scope>` block AIR renders, the other is what a template interpolates
     * against. Same shape the subprocess manager returned.
     */
    function currentScope() {
        return { modules: [CAPSULE_SCOPE_MODULE, ...blueprint.tools.map(tool => tool.scope)] }
    }

    /**
     * One execution, awaited to its terminal event.
     *
     * The subprocess manager built this by correlating a `cmd:run` command
     * with a `capsule:cmd:complete` event off the wire. In one heap the run
     * returns a promise directly — but the RESULT still comes off the bus,
     * because that is where the value and the scope diff are published and
     * duplicating them into a return value would give two sources for one
     * fact.
     */
    function exec(code: string, runOpts: {
        id?: string
        timeout?: number
        signal?: AbortSignal
        onConsole?: (level: "log" | "info" | "warn" | "error" | "debug", args: unknown[]) => void
        origin?: "cognet" | "host"
    } = {}): Promise<CapsuleExecResult> {
        if (!booted) return Promise.reject(err("CAPSULE_DOWN", { context: { cmd: "cmd:run" } }))

        const id = runOpts.id ?? randomUUID()

        return new Promise<CapsuleExecResult>((resolve, reject) => {
            const offs: Array<() => void> = []
            let settled = false
            const settle = (fn: () => void) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                for (const off of offs) off()
                fn()
            }

            const timeout = runOpts.timeout ?? 300_000
            const timer = setTimeout(() => {
                bus.emit("process:cmd:interrupt:requested", { id, reason: "timeout" })
                sandbox.kill(id)
                // A plain Error, matching the subprocess manager: the kernel's
                // runOne() classifies a timeout by matching /timed out/ on the
                // message, so an AxonError with a different message would come
                // back as "exception" rather than "timeout".
                settle(() => reject(new Error(`capsule run timed out after ${timeout}ms`)))
            }, timeout)

            if (runOpts.onConsole) {
                offs.push(bus.on("process:console", event => {
                    if (event.commandId === id) runOpts.onConsole!(event.level, event.args)
                }))
            }

            offs.push(
                bus.on("process:cmd:complete", event => {
                    if (event.id !== id) return
                    settle(() => resolve({
                        // `undefined` normalises to `null`, as it always has.
                        //
                        // The JSONL wire did this incidentally — JSON has no
                        // undefined, so a run returning nothing came back as
                        // null and the contract documented that. In one heap
                        // there is no serialisation to do it, but the contract
                        // is what callers were written against: a model
                        // reading `undefined` where it expected `null` is a
                        // behaviour change nobody asked for, so it is done
                        // deliberately here instead of by accident there.
                        value: event.result === undefined ? null : event.result,
                        scope: event.scope ?? EMPTY_CAPSULE_SCOPE,
                    }))
                }),
                bus.on("process:cmd:failed", event => {
                    if (event.id !== id) return
                    settle(() => reject(err("CAPSULE_CMD_FAILED", { detail: event.error?.message ?? "command failed", context: { id } })))
                }),
                bus.on("process:cmd:interrupted", event => {
                    if (event.id !== id) return
                    settle(() => reject(shuttingDown
                        ? new Error("capsule exited during run")
                        : abortError()))
                }),
            )

            const onAbort = () => {
                bus.emit("process:cmd:interrupt:requested", { id, reason: "abort" })
                sandbox.kill(id)
                settle(() => reject(abortError()))
            }
            runOpts.signal?.addEventListener("abort", onAbort, { once: true })
            offs.push(() => runOpts.signal?.removeEventListener("abort", onAbort))
            if (runOpts.signal?.aborted) { onAbort(); return }

            inflight.add(id)
            offs.push(() => inflight.delete(id))
            const { done } = sandbox.run(code, { id, ...(runOpts.origin ? { origin: runOpts.origin } : {}) })
            // The run's own rejection is not the result — the terminal EVENT
            // is. This only exists so a throw inside run() cannot become an
            // unhandled rejection while the listeners above settle.
            void done.catch(() => {})
        })
    }

    return {
        run: (code: string, runOpts?: Parameters<typeof exec>[1]) => exec(code, runOpts).then(result => result.value),
        exec,

        /**
         * Cancel every running submission.
         *
         * COOPERATIVE — mediated calls observe the signal and return, which
         * covers every await-shaped operation model code actually writes. What
         * it cannot do is stop a tight synchronous loop: the subprocess
         * manager killed the process to guarantee that, and there is no second
         * process here to kill.
         *
         * Every in-flight run is aborted through its own controller, so the
         * runner emits `cmd:interrupted` and `exec()` settles by rejecting.
         * Killing the children alone left those promises pending — the caller
         * saw the work stop and the call never return.
         *
         * Async to match the subprocess manager, whose interrupt awaited a
         * hard reset.
         */
        async interrupt(): Promise<void> {
            for (const id of [...inflight]) {
                // Announced BEFORE the cancel, as the subprocess manager did.
                // Anything correlating to this command — a host call
                // unwinding, a managed child — watches for this to know the
                // cancel is coming rather than inferring it from the terminal
                // event that follows.
                bus.emit("process:cmd:interrupt:requested", { id, reason: "abort" })
                sandbox.kill(id)
            }
            sandbox.procs.killAll()
        },

        /**
         * The managed process tree — read LIVE, never captured.
         *
         * `update()` replaces the sandbox, and a captured `procs` would keep
         * spawning through the old mediator: a rule the user had just granted
         * would still deny, because the object answering was built against the
         * policy they replaced. Same reason `scope` is a getter.
         */
        get process() { return sandbox.procs },

        get scope() { return currentScope() },

        /** No root process of our own: the agent process IS the runtime. */
        get main() {
            return { pid: process.pid, status: "running" as const, startedAt: null }
        },

        on: bus.on,
        once: bus.once,
        off: bus.off,
        onAny: bus.onAny,

        async boot(): Promise<void> {
            await sandbox.boot(blueprint.tools)
            booted = true
        },

        async update(partial: CapsulePartialConfig): Promise<void> {
            blueprint = mergeCapsuleConfig(blueprint, partial)
            // A new policy means a new mediator, and the simplest correct
            // answer is a fresh sandbox — the subprocess manager rebuilt its
            // incarnation for exactly this reason. Tool state is reloaded from
            // the blueprint, which is the authority either way.
            //
            // The OLD sandbox is torn down AFTER the new one exists in the
            // subprocess design ("new goes live first — overlap, not gap").
            // Here the order is reversed deliberately: both share one process,
            // so a live overlap would mean two mediators owning `process.run`
            // at once and model code gated by whichever installed last.
            sandbox.shutdown()
            sandbox = InProcSandbox({ config: blueprint, bus })
            await sandbox.boot(blueprint.tools)
        },

        async shutdown(): Promise<void> {
            // Cancel what is running BEFORE tearing down. A run in flight when
            // the capsule goes away has no way to complete, and leaving its
            // promise pending is how a caller hangs forever on work whose
            // machinery no longer exists — the subprocess got this for free
            // (the process died and the wire broke), and here it is explicit.
            // SHUTDOWN, not interrupt — and the distinction reaches the
            // caller. An interrupted run was cancelled and the capsule is
            // still there; a run cut short by shutdown has nowhere to resume,
            // and telling the two apart is what lets a caller decide whether
            // retrying makes sense.
            shuttingDown = true
            for (const id of [...inflight]) {
                bus.emit("process:cmd:interrupt:requested", { id, reason: "abort" })
                sandbox.kill(id)
            }
            sandbox.shutdown()
            booted = false
        },
    }
}

/**
 * The abort the subprocess manager produced, word for word.
 *
 * Callers match on this message — the kernel's runOne() classifies an outcome
 * by testing the error, and tests assert the substring. A different wording is
 * a silent contract change dressed as a cosmetic one.
 */
function abortError(): Error {
    const error = new Error("capsule run aborted")
    error.name = "AbortError"
    return error
}

export type InProcCapsuleT = ReturnType<typeof InProcCapsule>
