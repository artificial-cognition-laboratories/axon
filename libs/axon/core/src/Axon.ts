import { AxonCloud } from "@arcforge/cloud"
import type { AxonCloudClient } from "@arcforge/cloud"
import type { AxonEngineDriver, AxonEscalate, AxonHost, AxonPartialBlueprint } from "@arcforge/types"
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
import { Inference } from "./runtime/inference"
import { Cognet } from "./cognet"
import { Modules } from "./modules"
import { Tools } from "./tools"
import { resolve } from "node:path"

type AxonOpts = {
    blueprint: AxonPartialBlueprint
    /** Host invocation directory inherited by the capsule. Not agent configuration. */
    cwd?: string
    /**
     * The event bus this runtime announces on. Supply one to observe boot —
     * anything constructed in here is subscribable only after boot is over.
     */
    bus?: ReturnType<typeof AxonBus>
    /**
     * An already-authenticated cloud client — the host's identity. The TUI
     * passes its logged-in profile client so the agent runs AS the user
     * (vault connections, billing). Omitted (deployed runtime, tests), the
     * runtime builds its own from the agent env's AXON_API_KEY.
     */
    cloud?: AxonCloudClient
    /** Trusted platform services available to capsule code through its Axon facade. */
    host?: AxonHost
    /**
     * The platform's policy decider — consulted when a rule says "escalate".
     *
     * Separate from `host` on purpose: that is the GUEST's channel into the
     * platform, and a sandboxed program able to reach the decider could raise
     * or answer its own escalations. This is host code asking host code.
     *
     * Absent = no decider, which the capsule treats as deny. That is the
     * honest state for `axon run` in a script and for any embedder that never
     * wired a surface to ask.
     */
    escalate?: AxonEscalate
    /**
     * Inference lives outside this process.
     *
     * Set by the agent entrypoint when this runtime is CONFINED: the provider
     * credential is held by the supervisor and must never enter the box, so
     * the agent asks for a role and receives tokens over the link. Absent
     * everywhere else, where inference is resolved and performed in this heap.
     *
     * A driver, so nothing above it changes: the Engine manager keeps owning
     * AIR, retries and the stall guard, and cannot tell the tokens crossed a
     * process boundary.
     */
    remote?: (role: string) => AxonEngineDriver
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
    /**
     * Environmental, like session and cloud — and ACCEPTED from a caller
     * that needs to observe boot.
     *
     * A confined agent forwards every commit to its supervisor by
     * subscribing to this bus. Constructed only in here, the earliest a
     * caller could subscribe was after `Axon()` returned — by which point
     * boot has already announced and passed. That was invisible while the
     * agent also wrote its own log; once the supervisor became the only
     * writer, every boot event simply vanished from the record.
     */
    const bus = opts?.bus ?? AxonBus()
    const hooks = Hooks()

    const cloud = opts?.cloud ?? AxonCloud({
        // The SUPERVISOR's credential, from hostEnv — never from `env`, which
        // is the agent's own .env and crosses into the box. See AxonBlueprint.
        key: blueprint.hostEnv?.AXON_API_KEY ?? blueprint.env.AXON_API_KEY,
    })

    /**
     * The agent's own session — in memory always, on disk only when nothing
     * else owns the file.
     *
     * A CONFINED agent (`remote` set) commits, announces on its bus, and
     * `agent-main` forwards each entry to the supervisor, which holds the
     * durable record. Writing here as well put two AxonSessions over one
     * path, each with its own seq counter: the log carried interleaved
     * streams whose sequence numbers ran backwards, every entry appeared
     * twice, and anything counting entries read double.
     *
     * The supervisor being the only writer is also the security property the
     * boundary is for — the agent may APPEND to the record through the link
     * and can never rewrite it.
     */
    const session = await AxonSession({ blueprint, bus, persist: !opts?.remote })

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
            // Cognet resolution and role resolution are INDEPENDENT: one is a
            // disk read plus a JS import, the other is network work against
            // the user's providers. Run concurrently, the boot pays the
            // slower of the two rather than their sum.
            //
            // Both still complete before the kernel, so the ordering
            // guarantee below is unchanged — a required role that nothing can
            // fill stops the boot before ring 0 exists, exactly as when these
            // were sequential. What changed is only that the waiting overlaps.
            //
            // Started together and awaited together: a rejection in either is
            // observed by the Promise.all, so neither can become an unhandled
            // rejection while the other is still in flight.
            // Role RESOLUTION is skipped entirely when inference is remote.
            //
            // Resolving a role means reaching the user's providers over the
            // network and building a driver from a credential — which is the
            // one thing a confined agent must never do. The supervisor already
            // resolved these roles on its own side; the agent asks for a role
            // by name and receives tokens.
            //
            // Skipped rather than resolved-and-ignored: a confined box has no
            // credential to resolve WITH, so attempting it fails the boot with
            // ENGINE_REQUIREMENTS_UNMET before the remote driver is ever
            // consulted. It is also the wrong work to do twice.
            const [cognet, engines] = await Promise.all([
                Cognet({ blueprint, session }),
                opts?.remote ? Promise.resolve(undefined) : Inference({ blueprint, cloud, session }),
            ])

            // Boot renders the agent's identity (boot.md / boot.vue). It is a
            // presentation concern, so it is built HERE and handed to the
            // kernel as base() rather than living in ring 0.
            const boot = Boot({ blueprint, session })

            const kernel = await session.span("axon:kernel", {}, () => Kernel({
                blueprint: blueprint,
                ...(opts?.remote ? { remote: opts.remote } : {}),
                ...(engines ? { engines } : {}),
                bus: bus,
                cloud: cloud,
                cognet: cognet,
                session: session,
                base: async () => (await boot.render()) ?? "", // absent boot → "", never undefined
                onUpdate: next => boot.update(next),
                cwd,
                ...(opts?.host ? { host: opts.host } : {}),
                ...(opts?.escalate ? { escalate: opts.escalate } : {}),
            }))

            // Tools live IN THIS PROCESS — the only place they can.
            //
            // Loaded after the kernel exists (mediation needs its policy and
            // its span stream) and before the handle, so every surface built
            // on top of it sees the same set.
            //
            // Unconditional. This used to be gated on `remote`, which means
            // "inference crosses the link" — an unrelated fact that happened
            // to coincide with confinement. Anything booted without it loaded
            // ZERO tools, so a script run that way failed with "fs is not
            // defined" for a module its config plainly installed.
            const tools = Tools({ mediation: kernel.mediation })
            await tools.install(blueprint.tools)

            // user facing handle
            const axon = AxonHandle({
                blueprint: blueprint,
                kernel: kernel,
                session: session,
                hooks: hooks,
                cloud: cloud,
                inject: inject,
                bus: bus,
                // A thunk: a hot reload rebuilds the set, and a captured map
                // would keep serving a tool the author deleted.
                loaded: () => tools.globals(),
            })

            // inject before [middleware, plugins, hooks]. The blueprint rides
            // along because tool globals follow its `flat` placement — the
            // agent's own src/tools land as top-level globals, a module's under
            // its namespace, exactly as the capsule installs them.
            inject.runtime(axon, blueprint, () => tools.globals())

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
