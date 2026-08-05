import { AxonCloud } from "@arclabs/cloud"
import type { AxonCloudClient } from "@arclabs/cloud"
import type { AxonHost, AxonPartialBlueprint } from "@arcforge/types"
import { err } from "@arcforge/err"
import { AxonBlueprint } from "./platform"
import { Inject } from "./platform"
import { AxonBus } from "./platform"
import { Hooks } from "./platform"
import { Kernel } from "@arcforge/kernel"
import { Boot } from "./platform"
import { AxonSession, home } from "@arcforge/session"

import { AxonHandle } from "./runtime"
import { AxonRuntime } from "./runtime/runtime"
import { Cognet } from "./cognet"
import { Modules } from "./modules"
import { resolve } from "node:path"

type AxonOpts = {
    blueprint: AxonPartialBlueprint
    /** Host invocation directory inherited by the capsule. Not agent configuration. */
    cwd?: string
    /**
     * An already-authenticated cloud client — the host's identity. The TUI
     * passes its logged-in profile client so the agent runs AS the user
     * (vault connections, billing). Omitted (deployed runtime, tests), the
     * runtime builds its own from the agent env's AXON_API_KEY.
     */
    cloud?: AxonCloudClient
    /** Trusted platform services available to capsule code through its Axon facade. */
    host?: AxonHost
}

export type { AxonHost } from "@arcforge/types"

/**
 * Axon runtime factory.
 *
 * Pure composition — normalizes the blueprint at the one seam, builds each
 * handle in dependency order, and hands the assembled set to AxonRuntime.
 * No work happens here that isn't wiring.
 *
 * Session is constructed here, environmental like bus/cloud — not owned by
 * the kernel. Every handle that needs to read or commit session facts
 * (Kernel, AxonRuntime, AxonHandle) receives it directly; the kernel's own
 * relationship to it is narrowed to mediating the untrusted cognet's access
 * through the ABI (output()/run() only), never holding it as its own state.
 * This is also the earliest point axon:boot:start can be durably recorded, and
 * the outer try/catch is the one place axon:boot:failed can be recorded for any
 * failure during the rest of construction.
 */
export async function Axon(opts?: AxonOpts) {
    const bootStarted = Date.now()
    const inject = Inject()
    inject.macros()

    const blueprint = AxonBlueprint(opts?.blueprint)
    const cwd = resolve(opts?.cwd ?? process.cwd())
    const bus = AxonBus()
    const hooks = Hooks()

    const cloud = opts?.cloud ?? AxonCloud({
        key: blueprint.env.AXON_API_KEY,
    })

    const session = await AxonSession({ blueprint, bus })

    // Everything from here runs under this session's error scope: any
    // AxonError constructed during the rest of boot attributes to THIS
    // session's log, never another instance's in the same process.
    return await session.scope(async () => {
        await session.commit("axon:boot:start", {
            version: blueprint.agent.version,
            agentRoot: blueprint.paths.root,
            // an explicit cloud client means the TUI handed us the host's own
            // logged-in identity (local dev); its absence means we built one
            // from the deployed agent's own AXON_API_KEY (cloud runtime).
            mode: opts?.cloud ? "local" : "cloud",
        })

        try {
            const cognet = await Cognet({ blueprint })

            // Boot renders the agent's identity (boot.md / boot.vue). It is a
            // presentation concern, so it is built HERE and handed to the
            // kernel as base() rather than living in ring 0.
            const boot = Boot({ blueprint, session })

            const kernel = await Kernel({
                blueprint: blueprint,
                bus: bus,
                cloud: cloud,
                cognet: cognet,
                session: session,
                base: async () => (await boot.render()) ?? "", // absent boot → "", never undefined
                onUpdate: next => boot.update(next),
                cwd,
                ...(opts?.host ? { host: opts.host } : {}),
            })

            // user facing handle
            const axon = AxonHandle({
                blueprint: blueprint,
                kernel: kernel,
                session: session,
                hooks: hooks,
                cloud: cloud,
                inject: inject,
                bus: bus,
            })

            // inject before [middleware, plugins, hooks]. The blueprint rides
            // along because tool globals follow its `flat` placement — the
            // agent's own src/tools land as top-level globals, a module's under
            // its namespace, exactly as the capsule installs them.
            inject.runtime(axon, blueprint)

            // Run declared modules' setup() against the live handle, in
            // blueprint order, before the runtime finishes booting — so a
            // module's hooks and live resources (Discord gateway, timers) are
            // wired before the first request. A setup failure fails boot.
            const modules = await Modules({ blueprint, hooks, session })

            return await AxonRuntime({
                blueprint: blueprint,
                cloud: cloud,
                axon: axon,
                kernel: kernel,
                session: session,
                bus: bus,
                hooks: hooks,
                modules: modules,
                bootStarted: bootStarted,
            })
        } catch (cause) {
            const failure = err(cause)
            // The thrown error names its own durable record — a host that
            // never got a runtime handle (failed boot) reads the log the
            // ERROR points at, not a process-global env var that another
            // instance may have clobbered since.
            failure.context = {
                ...failure.context,
                sessionId: session.id,
                sessionFile: home.data.sessions.path(resolve(blueprint.paths.root, blueprint.paths.data), session.id),
            }
            await session.commit("axon:boot:failed", { error: failure, durationMs: Date.now() - bootStarted })
            throw failure
        }
    })
}

export type AxonT = Awaited<ReturnType<typeof Axon>>
