import { err } from "@arcforge/err"
import type { CapsuleCommand, CapsuleBlueprint, CapsulePartialConfig } from "../../types"
import { Build, type CapsuleRuntime } from "../build/build"
import type { CapsuleBusT } from "../../platform/bus"
import { mergeCapsuleConfig } from "../blueprint"
import { Escalation } from "./escalation"
import { Exec } from "./exec"
import { Procs } from "./procs"
import { CAPSULE_SCOPE_MODULE } from "../scope/declarations"
import { Host } from "./host"

type SubprocessOpts = {
    config: CapsuleBlueprint
    bus: CapsuleBusT
}

/**
 * CapsuleSubprocess — our handle for the sandboxed subprocess. Owns which
 * incarnation is alive (crash supervision, restart windowing) and every
 * conversation held with it — code execution, managed child processes,
 * policy escalation. These are not independent domains; they are all
 * clients of this subprocess's send(), so they live here rather than being
 * wired externally by Capsule().
 *
 * Emits capsule:ready (build returned = fully usable), restarting/restarted/dead.
 */
export function CapsuleSubprocess(opts: SubprocessOpts) {
    const { bus } = opts

    let config = opts.config
    let current: CapsuleRuntime | null = null
    let shuttingDown = false
    let bootedAt: number | null = null
    let hardReset: Promise<void> | null = null

    function send(cmd: CapsuleCommand) {
        if (!current) throw err("CAPSULE_DOWN", { context: { cmd: cmd.type } })
        current.send(cmd)
    }

    /** Hard cancellation boundary for JavaScript that cannot observe AbortSignal. */
    function hardInterrupt(): Promise<void> {
        if (hardReset) return hardReset

        hardReset = (async () => {
            if (shuttingDown) return
            const previous = current
            if (!previous) return

            // Clear first: the expected exit from this incarnation must not
            // consume crash supervision's restart budget. Give the sandbox a
            // brief chance to process shutdown so it can kill managed children
            // before the unconditional OS kill.
            current = null
            const exited = new Promise<void>(resolve => {
                const off = bus.on("capsule:exit", () => { off(); resolve() })
                setTimeout(() => { off(); resolve() }, 50)
            })
            try { previous.send({ type: "shutdown" }) } catch { /* broken wire — kill below */ }
            await exited
            previous.kill()
            await previous.cleanup()

            if (shuttingDown) return
            try {
                current = await Build({ config, bus })
                bootedAt = Date.now()
            } catch (cause) {
                bus.emit("capsule:dead", { error: err("CAPSULE_DEAD", { detail: "hard reset failed to rebuild the capsule", cause }).toJSON() })
                throw cause
            }
        })().finally(() => { hardReset = null })

        return hardReset
    }

    const exec = Exec({ send, bus, hardInterrupt })
    const procs = Procs({ send, bus })
    Host({ send, bus, ...(config.host ? { host: config.host } : {}) })
    Escalation({ send, bus, ...(config.escalate ? { decide: config.escalate } : {}) })

    // Crash windowing
    const max = config.restart?.max ?? 3
    const windowMs = config.restart?.windowMs ?? 5_000
    let restartCount = 0
    let lastCrashAt = 0

    // Crash supervision: the subprocess died and we didn't ask it to.
    bus.on("capsule:exit", () => {
        if (shuttingDown || !current) return
        current = null

        const now = Date.now()
        restartCount = now - lastCrashAt < windowMs ? restartCount + 1 : 1
        lastCrashAt = now

        if (restartCount > max) {
            bus.emit("capsule:dead", { error: err("CAPSULE_DEAD", { detail: "max restarts exceeded", context: { restartCount, max } }).toJSON() })
            return
        }

        const restartStarted = Date.now()
        bus.emit("capsule:restart:start", { restartCount })
        Build({ config, bus })
            .then(runtime => {
                current = runtime
                bootedAt = Date.now()
                bus.emit("capsule:restart:complete", { restartCount, durationMs: Date.now() - restartStarted })
            })
            .catch(cause => {
                const failure = err("CAPSULE_DEAD", { detail: "restart failed to rebuild the capsule", cause }).toJSON()
                // Close the bracket first, then report the terminal verdict —
                // an unclosed :start would hang open in every flame graph.
                bus.emit("capsule:restart:failed", { restartCount, error: failure, durationMs: Date.now() - restartStarted })
                bus.emit("capsule:dead", { error: failure })
            })
    })

    return {
        get current() {
            return current
        },

        /**
         * The capsule's root process — the sandboxed TS runtime itself.
         * Always exists conceptually (managed children are its children);
         * status is "down" between crash and restart.
         */
        get main() {
            return {
                pid: current?.pid,
                status: current ? ("running" as const) : ("down" as const),
                startedAt: bootedAt,
            }
        },

        // execution
        run: exec.run,
        /** run() plus the bindings the submission left — for template rendering. */
        exec: exec.exec,
        interrupt: exec.interrupt,

        // managed child processes — live mirror
        proc: procs,

        /** Complete executable TypeScript scope of this capsule incarnation. */
        get scope() {
            return {
                modules: [CAPSULE_SCOPE_MODULE, ...config.tools.map(tool => tool.scope)],
            }
        },

        /**
         * Explicit boot — construction wires, boot() spawns. Fails loudly.
         *
         * The host owns this bracket because this is where boot is actually
         * initiated and where a failure is observable: a subprocess that
         * dies during Build() never gets far enough to report anything about
         * itself. (The sandbox's own capsule:boot:complete, emitted from
         * inside once it is usable, is a different fact — "the guest
         * finished starting" — and carries the guest's uptime.)
         */
        async boot() {
            if (current) throw err("CAPSULE_ALREADY_BOOTED")
            const started = Date.now()
            bus.emit("capsule:boot:start", {})
            try {
                current = await Build({ config, bus })
            } catch (cause) {
                bus.emit("capsule:boot:failed", {
                    durationMs: Date.now() - started,
                    error: err("CAPSULE_BOOT_FAILED", { cause }).toJSON(),
                })
                throw cause
            }
            bootedAt = Date.now()
            bus.emit("capsule:ready", {})
        },

        // todo, figure out how to expose fully rendered process view. 
        // this will allow llms to use interactive processes by rendering
        // the terminal and allowing send keys.
        // interact: {
        //     async send() { }
        // },

        // /** capture output rendered into a grid for llm viewing */
        // async render() { },

        /** Loud when down — callers decide whether to retry, nothing queues silently. */
        send,

        /**
         * Partial config → merged + re-normalized → build new incarnation,
         * swap, tear down old. Overlap, not gap — same idiom as Backend.update().
         */
        async update(partial: CapsulePartialConfig) {
            const next = mergeCapsuleConfig(config, partial)
            const previous = current
            const replacement = await Build({ config: next, bus })
            config = next
            current = replacement
            if (previous) {
                previous.kill()
                await previous.cleanup()
            }
        },

        async shutdown() {
            if (shuttingDown) return
            shuttingDown = true
            const runtime = current
            current = null
            if (runtime) {
                runtime.send({ type: "shutdown" })
                runtime.kill()
                // Deliberate shutdown must not depend on the real OS exit
                // event racing cleanup()'s wire.detach() — kill() is async
                // (SIGTERM), and detach() runs synchronously right after,
                // reliably removing the exit listener before the process
                // actually dies. Any in-flight Exec.run() is listening for
                // capsule:exit to reject rather than hang forever; emit it
                // ourselves so a deliberate shutdown is as prompt as a real
                // crash, not silently unobservable.
                bus.emit("capsule:exit", { code: null })
                await runtime.cleanup()
            }
            bus.emit("capsule:shutdown", {})
        },
    }
}

export type CapsuleSubprocessT = ReturnType<typeof CapsuleSubprocess>
