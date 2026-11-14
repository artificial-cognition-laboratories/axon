import { join } from "node:path"
import { spawnConfined, agentEntrypoint } from "@arcforge/link"
import { AGENT_ENTRYPOINTS, SupervisorSideServices } from "@arcforge/platform/link"
import type { UsageT } from "./usage"
import { isEntryEvent, Policy, type AxonBlueprint, type EngineCapability } from "@arcforge/types"
import type { AxonEngineRequest, AxonEngineRawEvent } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"

/** How often a running agent's cost is sampled into its session. */
const USAGE_MS = 2_000

type SuperviseOpts = {
    /** What each agent costs the machine, part by part. Absent: nothing is sampled. */
    usage?: UsageT
    /** Where agents write CPU profiles, one folder per session (AXON_PROFILE). Absent: nothing profiles. */
    profiles?: string
    /**
     * Holds the provider credential — the one asset that must never enter the
     * box.
     *
     * A THUNK, read at spawn rather than captured. The platform builds the
     * cloud client and the daemon supervises the platform's agents, so a value
     * here forces one to exist before the other; deferring the read breaks
     * that cycle without either learning about the other's construction. Same
     * reason `control` and `budget` are thunks elsewhere.
     */
    cloud: () => AxonCloudClient
    /**
     * The human decider for an escalation.
     *
     * Optional, and its ABSENCE means deny — a daemon with no surface to ask
     * cannot answer on a person's behalf, and defaulting to allow would make
     * an unattended agent strictly more privileged than an attended one.
     */
    decide?: (input: { agent: string; sessionId: string }, call: unknown) => Promise<boolean>
    /** Thunk because Models is assembled after the supervisor. */
    local?: () => { catalogue(): Promise<EngineCapability[]>; run(model: string, input: unknown): Promise<unknown>; stream(model: string, request: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent> }
}

type SpawnInput = {
    sessionId: string
    /** Already normalised and prepared — see Agents.spawn for why the daemon never resolves one. */
    blueprint: AxonBlueprint
    /** The agent's name, for a policy grant. Grants are written against a name. */
    agent: string
}

/**
 * Supervise — hold what must never enter an agent's box.
 *
 * ── The rule this file exists to enforce ────────────────────────────────────
 *
 * An asset whose loss is UNRECOVERABLE and whose stolen form is PORTABLE must
 * never enter the untrusted process. A stolen file is one machine's data; a
 * stolen provider key is a live capability that works from anywhere, forever,
 * until someone notices and rotates it.
 *
 * So three things stay here: inference (the credential), the session log (an
 * attacker who can rewrite the audit trail has erased the evidence of
 * everything else), and the escalation decider (a program able to reach it
 * could answer its own escalations).
 *
 * ── Why the DAEMON holds them ───────────────────────────────────────────────
 *
 * It held them in whichever process spawned the agent, which made an agent's
 * lifetime and its controllability both properties of its launcher. Close the
 * terminal and the agent went with it; start one headlessly and nothing could
 * ever speak to it again.
 *
 * A daemon is the only thing on the machine that outlives a terminal, so
 * boot-time agents and scheduled wakeups are impossible until it is the one
 * supervising. That is the whole reason this moved.
 */
export function Supervise(opts: SuperviseOpts) {
    return {
        /**
         * Boot one agent behind the link, and return the live handle.
         *
         * The blueprint arrives PREPARED. Resolving a reference, opening a
         * project and preparing it is the platform's work and needs the whole
         * project stack; the daemon boots what it is handed. That is what
         * keeps "which agent do I run" out of a process whose job is running
         * them.
         */
        async spawn(input: SpawnInput) {
            const services = await SupervisorSideServices({
                blueprint: input.blueprint,
                cloud: opts.cloud(),
                sessionId: input.sessionId,
                ...(opts.local ? {
                    local: {
                        catalogue: () => opts.local!().catalogue(),
                        run: (model, input) => opts.local!().run(model, input),
                        stream: (model, request) => opts.local!().stream(model, request),
                    },
                } : {}),
            })

            // A brain that declares roles — or uses, which may be served by
            // engines — learns, before it starts, which of them were filled:
            // the only way the box can tell a filled optional role from an
            // empty one. Brains with neither pay nothing.
            const declared = Object.keys(input.blueprint.cognet.engines ?? {}).length > 0
                || Object.keys(input.blueprint.cognet.uses ?? {}).length > 0
                || (input.blueprint.serviceProviders ?? []).some(provider => Object.keys(provider.engines).length > 0)
            const blueprint = declared
                ? { ...input.blueprint, cognet: { ...input.blueprint.cognet, resolvedEngines: await services.engines.facts() } }
                : input.blueprint

            const resolved = Policy({
                blueprint: input.blueprint,
                tools: (input.blueprint.tools ?? []).map(tool => tool.name),
            })

            const spawned = await spawnConfined({
                sessionId: input.sessionId,
                blueprint: blueprint,
                policy: resolved.policy,
                entrypoint: agentEntrypoint(AGENT_ENTRYPOINTS),
                ...(opts.profiles ? { profile: join(opts.profiles, input.sessionId) } : {}),
                services: {
                    // The agent names a ROLE and receives tokens. It can cause
                    // inference and can never obtain, transfer or outlive the
                    // key that performs it.
                    infer: (call, signal) => services.infer(call, signal),
                    // Features, masks, speech — the same boundary, one result back.
                    transform: (call, signal) => services.transform(call, signal),
                    /**
                     * Routed by CLASSIFICATION, not by one verb.
                     *
                     * `commit` appends to the log; `commitEntry` appends to
                     * `entries` — the conversation a UI renders. The wire
                     * carries one verb, so sending everything through
                     * `commit` fills the log and leaves the screen blank.
                     *
                     * `isEntryEvent` is the same predicate the in-process
                     * runtime routes on, so both agree by construction rather
                     * than by a second list kept in step.
                     */
                    commit: (type, data, ctx) => {
                        if (isEntryEvent(type as string)) {
                            void services.session.commitEntry(type as never, data as never, ctx)
                            return
                        }
                        void services.session.commit(type, data, ctx)
                    },
                    ...(opts.decide
                        ? {
                            escalate: async call => ({
                                allow: await opts.decide!({ agent: input.agent, sessionId: input.sessionId }, call),
                            }),
                        }
                        : {}),
                },
                onError: error => {
                    void services.session.commit("axon:log:error", { message: error.message } as never)
                },
            })

            /*
             * What this agent costs, into its own session, while it runs — so a
             * reader scrubbing back sees what it cost THEN. A sampler that
             * fails says so in the session and stops; it never takes the
             * daemon down with it.
             */
            const sampler = opts.usage?.of(spawned.process.pid) ?? null
            let sampling: ReturnType<typeof setInterval> | null = null
            const quiet = () => {
                if (sampling) clearInterval(sampling)
                sampling = null
                sampler?.close()
            }
            if (sampler) {
                // One sample at a time: reading the labs may cross a socket,
                // and a slow one must not stack measures behind it.
                let measuring = false
                sampling = setInterval(() => {
                    if (measuring) return
                    measuring = true
                    sampler.measure().then(
                        usage => { void services.session.commit("axon:usage", usage) },
                        cause => {
                            void services.session.commit("axon:log:error", { message: `usage sampling stopped: ${cause instanceof Error ? cause.message : String(cause)}` } as never)
                            quiet()
                        },
                    ).finally(() => { measuring = false })
                }, USAGE_MS)
                sampling.unref?.()
                void spawned.process.exited.then(quiet)
            }

            return {
                sessionId: input.sessionId,
                link: spawned.link,
                session: services.session,
                bus: services.bus,
                engines: services.engines,
                /**
                 * The agent process's pid — what a liveness probe checks.
                 *
                 * Not the supervisor's: a reader uses this to decide whether
                 * the session is alive, and reporting the daemon's would keep
                 * a dead agent looking healthy for as long as the daemon ran.
                 */
                pid: spawned.process.pid,
                /** Which containment tier actually built the box. Reported, never assumed. */
                tier: spawned.tier,
                /** The blueprint this agent booted with — the supervisor's copy. */
                blueprint: input.blueprint,
                /** Shut the agent down and close the log. */
                async stop(): Promise<void> {
                    quiet()
                    await spawned.dispose()
                },
            }
        },
    }
}

export type SuperviseT = ReturnType<typeof Supervise>

/** The live agents this daemon supervises, by session id. */
export type Supervised = Awaited<ReturnType<SuperviseT["spawn"]>>
