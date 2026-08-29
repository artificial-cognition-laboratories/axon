import { err } from "@arcforge/err"
import { isEntryEvent, Policy } from "@arcforge/types"
import { spawnConfined, agentEntrypoint } from "@arcforge/link"
import { AGENT_ENTRYPOINTS, SupervisorSideServices } from "@arcforge/platform/link"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonCloudClient } from "@arcforge/cloud"

type SuperviseOpts = {
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
            })

            const resolved = Policy({
                blueprint: input.blueprint,
                tools: (input.blueprint.tools ?? []).map(tool => tool.name),
            })

            // What the primary role resolved to, stamped on before the
            // blueprint crosses: the agent has no credential and so cannot
            // resolve this itself.
            const engine = services.engine
            if (engine) (input.blueprint as { engine?: unknown }).engine = engine

            const spawned = await spawnConfined({
                sessionId: input.sessionId,
                blueprint: input.blueprint,
                policy: resolved.policy,
                entrypoint: agentEntrypoint(AGENT_ENTRYPOINTS),
                services: {
                    // The agent names a ROLE and receives tokens. It can cause
                    // inference and can never obtain, transfer or outlive the
                    // key that performs it.
                    infer: (call, signal) => services.infer(call, signal),
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
                    commit: (type, data) => {
                        if (isEntryEvent(type as string)) {
                            void services.session.commitEntry(type as never, data as never)
                            return
                        }
                        void services.session.commit(type, data)
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

            return {
                sessionId: input.sessionId,
                link: spawned.link,
                session: services.session,
                bus: services.bus,
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
                /** The resolved inference roles, held supervisor-side. */
                ...(services.engines ? { engines: services.engines } : {}),
                /** The blueprint this agent booted with — the supervisor's copy. */
                blueprint: input.blueprint,
                /** Shut the agent down and close the log. */
                async stop(): Promise<void> {
                    await spawned.dispose()
                },
            }
        },
    }
}

export type SuperviseT = ReturnType<typeof Supervise>

/** The live agents this daemon supervises, by session id. */
export type Supervised = Awaited<ReturnType<SuperviseT["spawn"]>>
