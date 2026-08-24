import type { AxonCloudClient } from "@arclabs/cloud"
import { err } from "@arcforge/err"
import type { AxonBlueprint as AxonBlueprintT, AxonPartialBlueprint } from "@arcforge/types"
import { AxonBusT, AxonHooksT, mergeBlueprint } from "../platform"
import type { AxonHandle } from "./handle"
import { AxonKernelT } from "@arcforge/kernel"
import type { AxonSessionT } from "@arcforge/session"
import type { ModulesT } from "../modules"
import { AxonServer } from "./server"

type AxonRuntimeOpts = {
    blueprint: AxonBlueprintT
    cloud: AxonCloudClient
    axon: ReturnType<typeof AxonHandle>
    kernel: AxonKernelT
    /** Environmental — constructed at the Axon() seam, not kernel-owned. Every runtime-level commit goes through this directly. */
    session: AxonSessionT
    /** The raw event bus — trusted-host-only (devtools/TUI live event streaming via onAny). Never on AxonHandle. */
    bus: AxonBusT
    hooks: AxonHooksT
    /** Live module set — reloaded on update(), disposed on shutdown(). */
    modules: ModulesT
    /** Date.now() captured at the top of Axon() — axon:boot:complete measures from here. */
    bootStarted: number
}

/**
 * Final assembly. Axon() only composes the pieces — this is where the
 * composed runtime gets one coherent shape, one canonical blueprint, and
 * one shutdown path.
 *
 * The runtime owns the current blueprint. update() merges + re-normalizes
 * exactly once, then hands every handle the same complete new blueprint —
 * handles decide locally whether to react, but they can never diverge on
 * what the agent currently is.
 *
 * kernel and session are siblings on the returned handle, for trusted host
 * code only (TUI, CLI, tests) — never on `axon` (AxonHandle), which is the
 * curated, sandboxed surface agent-authored scripts see. A script reaches
 * `axon.request(...)`; a host reaches `runtime.kernel.request(...)` or
 * `runtime.session` directly when it genuinely needs the execution or
 * memory surface itself. The kernel was never meant to be reached FOR
 * session access (that was the original design mistake this fixes) — it's
 * fine as a first-class sibling for its own purpose, execution/OS
 * orchestration. No thread concept anywhere here: one session is always
 * exactly one continuous entry log.
 */
export async function AxonRuntime(opts: AxonRuntimeOpts) {
    const session = opts.session
    let blueprint = opts.blueprint
    let revision = 0
    let server = await AxonServer({ blueprint, hooks: opts.hooks, axon: opts.axon, bus: opts.bus, session, ...(opts.kernel.engines ? { engines: opts.kernel.engines } : {}) })

    const runtime = {
        axon: opts.axon,
        kernel: opts.kernel,
        session: session,
        bus: opts.bus,
        cloud: opts.cloud,

        get blueprint() {
            return blueprint
        },

        /** The live fetch handler — rebuilt on every update(), so callers must re-read it after a reload rather than caching it. */
        get server() {
            return server
        },

        /**
         * Hot-reload trigger. One canonical merge here; the kernel fans the
         * full new blueprint out to its own organs (engine, loop, capsule).
         * Server is rebuilt too — new/changed routes and middleware only
         * take effect through a freshly constructed h3 app.
         *
         * The whole span lands in the session log — axon:reload:start, then
         * axon:reload:complete or axon:reload:failed. Failure both records AND
         * rethrows: durable for the UI, loud for the caller.
         */
        async update(partial: AxonPartialBlueprint, updateOpts?: { mode?: "merge" | "replace" }) {
            const started = Date.now()
            const nextRevision = revision + 1
            await session.commit("axon:reload:start", { revision: nextRevision })

            try {
                blueprint = mergeBlueprint(blueprint, partial, updateOpts?.mode)
                await opts.axon.update(blueprint)

                // Reload order is load-bearing. AxonServer() resets ALL hooks
                // and re-runs plugins on every build — which would wipe hooks a
                // module registered in setup(). So: dispose old module
                // resources first, rebuild the server (resets hooks, re-runs
                // plugins), THEN re-run module setup so its hooks land after
                // the reset and survive. Reload stays shutdown+boot for
                // modules — just interleaved with the server rebuild.
                await opts.modules.dispose()
                server = await AxonServer({ blueprint, hooks: opts.hooks, axon: opts.axon, bus: opts.bus, session, ...(opts.kernel.engines ? { engines: opts.kernel.engines } : {}) })
                await opts.modules.setup(blueprint)

                // The session log owns the runtime transaction; the entry
                // log owns the cognition-visible causal fact. One durable
                // generic system interaction per successful reload means AIR
                // does not need a hot-reload-specific timeline primitive.
                await session.commitEntry("axon:system:message", {
                    type: "hot-reload",
                    lang: "txt",
                    content: "Agent context hot-reloaded. The currently resolved system and scope are authoritative; account for any changes before continuing.",
                    attributes: { revision: String(nextRevision) },
                })

                await session.commit("axon:reload:complete", {
                    revision: nextRevision,
                    durationMs: Date.now() - started,
                    toolCount: blueprint.tools.length,
                })
                revision = nextRevision
            } catch (cause) {
                const failure = err(cause)
                await session.commit("axon:reload:failed", { revision: nextRevision, error: failure, durationMs: Date.now() - started })
                throw failure
            }
        },

        /**
         * Teardown is error-isolated: one handle failing to shut down never
         * leaves the others running. Collected failures rethrow at the end.
         * session.end() runs last, unconditionally — a failed kernel
         * shutdown must never skip flushing the log.
         *
         * The whole span lands in the session log — axon:shutdown:start, then
         * axon:shutdown:complete or axon:shutdown:failed — same shape as update()'s
         * axon:reload:start/complete/failed.
         */
        async shutdown(reason?: string) {
            const started = Date.now()

            /**
             * Phase timing for the shutdown-hang investigation.
             *
             * Shutdown is a chain of unbounded awaits over code we do not all
             * own (module dispose, cognet unload, capsule teardown), and the
             * observed freeze scales with SESSION LENGTH — which points at an
             * O(entries) walk rather than a stuck handler. Naming the phase is
             * the difference between fixing that walk and hiding it behind a
             * timeout.
             *
             * Writes to stderr because the TTY is already being torn down by
             * the time later phases run, and the session log is one of the
             * things being closed.
             */
            const trace = process.env.AXON_SHUTDOWN_TRACE === "1"
            let mark = Date.now()
            const phase = (name: string): void => {
                if (!trace) return
                const now = Date.now()
                process.stderr.write(`[shutdown] ${name} ${now - mark}ms (total ${now - started}ms)\n`)
                mark = now
            }

            await session.commit("axon:shutdown:start", { reason })
            phase("commit:start")
            await opts.hooks.callHook("shutdown:before")
            phase("hooks:shutdown:before")

            const failures: unknown[] = []

            for (const [name, close] of [
                // Modules first — release external connections (Discord gateway,
                // timers) in reverse order before the capsule that hosts tool
                // code is torn down.
                ["modules", () => opts.modules.dispose()],
                ["kernel", () => opts.kernel.shutdown()], // abort run → kill userland
            ] as const) {
                try {
                    await close()
                    phase(name)
                } catch (cause) {
                    phase(`${name}:failed`)
                    failures.push(err("HANDLE_SHUTDOWN_FAILED", { detail: `${name} shutdown failed`, context: { name }, cause }))
                }
            }

            if (failures.length > 0) {
                const failure = err(new AggregateError(failures, "runtime shutdown completed with failures"))
                await session.commit("axon:shutdown:failed", { error: failure, durationMs: Date.now() - started })
                await session.end()
                throw failure
            }

            await session.commit("axon:shutdown:complete", { durationMs: Date.now() - started })
            phase("commit:complete")
            await session.end()
            phase("session:end")
        },
    }

    // Durable session-log commit (forwards to the bus itself) — a bare
    // bus.emit would notify live listeners but never persist, leaving the
    // session record with no boot fact at all.
    await session.commit("axon:boot:complete", { durationMs: Date.now() - opts.bootStarted })

    // lifecycle hook — plugins registering boot:after expect the runtime
    // to actually wait on them before Axon() resolves
    await opts.hooks.callHook("boot:after")

    return runtime
}
