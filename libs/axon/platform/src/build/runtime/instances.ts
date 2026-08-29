import { join } from "node:path"
import { err } from "@arcforge/err"
import type { AxonCloudClient, RemoteAgentHandle } from "@arcforge/cloud"
import type { AxonHost } from "@arcforge/core"
import type { ConnectableDeployment } from "../../services/deployments"
import type { StoreT } from "../../services/store"
import type { ProjectT, ProjectsT } from "../project"
import { Agent, type AgentT, type LinkedRuntime } from "./agent"
import type { BootProgress, UnitTiming } from "./progress"
import type { ResolveT } from "./resolve"
import type { EscalationsT } from "./escalations"
import type { EscalationCall, SupervisorToAgent } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

/**
 * Where an instance's runtime lives.
 *
 * A local instance owns an Axon() runtime in this process, with a project on
 * disk it can reload and a bus to subscribe to. A remote instance is a deployed
 * agent reached over `/_axon/*`: no project, no reload, no bus — its events
 * arrive on the mirrored session's event stream instead.
 *
 * A discriminated union rather than an optional-field widening: the verbs that
 * only make sense locally (reload, serve, watcher) are ABSENT from the remote
 * branch, so nothing downstream can reach for them and find undefined.
 */
/**
 * A remote agent to bind to — the input side of attach().
 *
 * ONE shape for a deployment and a bare URL, because the difference between
 * them is not a difference in what attaching means: both are an agent already
 * running that this process does not own, reached over `/_axon/*`. What
 * actually differs is whether a capability token has to be minted, and that is
 * one optional field rather than a second code path.
 *
 * `url` is the identity here, not `deploymentId` — a URL is the one thing both
 * kinds always have, and it is what makes two attaches to the same agent
 * detectable as the same binding.
 */
export type RemoteTarget = {
    /** Base URL of the running agent — `http://localhost:3010`, or a deployment's URL. */
    url: string
    /** What to call it in a UI. Resolved from the health handshake when a caller has no name. */
    name: string
    /**
     * The registry agent id, when this is a deployment. Drives connect-token
     * minting: the capability presented is scoped to this agent alone, and the
     * user's own credential never leaves the control plane. Absent for a local
     * dev server, where the agent is inside its owner's trust boundary and the
     * connect gate is open.
     */
    agentId?: string
    /** Present only for a deployment — what the control plane knows it as. */
    deploymentId?: string
    tier?: string
    /**
     * What the agent reports it is carrying, resolved from the handshake.
     * Null when it did not say — an older agent, distinct from zero.
     */
    loaded?: { modules: number; tools: number } | null
    /**
     * The engine the agent declares, as it reported it. Null when it declares
     * none or did not say — the caller renders an empty row rather than
     * inventing one.
     */
    engine?: { provider: string; model: string | null } | null
}

/**
 * What a spawned agent's supervisor gives back.
 *
 * Named here rather than imported, because the platform declares what it needs
 * and the daemon satisfies it — the dependency points that way, and typing
 * this against the daemon's own return would invert it.
 */
export type AgentSupervisor = {
    supervise(input: {
        sessionId: string
        blueprint: unknown
        agent: string
        projectRoot: string
        dataRoot: string
        /**
         * The ownership graph — who spawned this, what tree it belongs to, how
         * deep. Carried across because the DAEMON writes the liveness record
         * now, and a record without these loses the subagent tree every reader
         * nests on.
         */
        parentSessionId?: string | null
        rootSessionId?: string
        depth?: number
        job?: string
        /** A control channel this process serves, published for readers. */
        control?: { port: number; token: string }
    }): Promise<{
        link: SupervisorToAgent & { close(): void }
        session: AxonSessionT
        bus: { onAny(handler: (type: string, data: unknown) => void): () => void }
        engines?: unknown
        blueprint: unknown
        tier: "none" | "auto" | "container" | "hardened"
        pid: number
        stop(): Promise<void>
    }>
}

export type InstanceSource =
    /**
     * An agent reached over a LINK — a real process, addressed by the six
     * verbs and never by a handle.
     *
     * Named for HOW it is reached rather than who spawned it. An agent this
     * process asked for and one adopted from a daemon are the same thing to
     * every consumer: the link is the whole surface either way.
     *
     * This was one of THREE kinds. `local` meant an Axon() runtime sharing
     * the caller's heap — no box around it, no policy enforceable against it —
     * and it became unreachable when every spawn started taking the confined
     * path. Deleting it took `isLocal` and `hasProject`'s two-kind widening
     * with it: a union of one is a type, and three guards over it were three
     * ways to ask a question with one answer.
     */
    | { kind: "linked"; project: ProjectT; agent: LinkedRuntime }
    /**
     * A deployment reached over `/_axon/*` — no project, no reload, no bus.
     * Its events arrive on the mirrored session's stream.
     */
    | { kind: "remote"; target: RemoteTarget; agent: RemoteAgentHandle }

export type InstanceT = {
    sessionId: string
    parentSessionId: string | null
    rootSessionId: string
    depth: number
    source: InstanceSource
}


/** Narrow to a linked instance — an agent in its own process on this machine. */
export function isLinked(instance: InstanceT): instance is InstanceT & { source: Extract<InstanceSource, { kind: "linked" }> } {
    return instance.source.kind === "linked"
}


/** Narrow to an attached deployment. */
export function isRemote(instance: InstanceT): instance is InstanceT & { source: Extract<InstanceSource, { kind: "remote" }> } {
    return instance.source.kind === "remote"
}

export type SpawnOpts = {
    session?: string
    /** Job directory this run answers, for correlation — see AgentOpts.job. */
    job?: string
    /** A local control channel the caller is listening on, published on the running record — see AgentOpts.control. */
    control?: { port: number; token: string }
    parentSessionId?: string
    /** User spawns take attention; an agent-initiated spawn deliberately does not. */
    focus?: boolean
    /**
     * Live boot progress, for a caller that shows one (the TUI's status line).
     * A cold boot is seconds of `bun install` and looks hung without it.
     * Observational only — see AgentOpts.onProgress.
     */
    onProgress?: (progress: BootProgress) => void
    /** What each timed unit of the build cost — see AgentOpts.onTiming. */
    onTiming?: (timing: UnitTiming) => void
}

type InstancesOpts = {
    /**
     * Who supervises a spawned agent.
     *
     * A SEAM, not the daemon package: the platform must not depend on the
     * daemon (the daemon depends on the platform, and a cycle between them is
     * the boundary being wrong). The caller supplies something that can boot a
     * blueprint and hold the credential — `Axond().agents` today, and a socket
     * client once the TUI stops hosting one.
     *
     * Optional: a Platform that never spawns needs none, and `spawn` is what
     * refuses when it is absent — at the call that needs it, naming the fix.
     */
    daemon?: AgentSupervisor
    store: StoreT
    projects: ProjectsT
    /** Owns every agent-reference form — path, profile name, registry package. */
    resolve: ResolveT
    cwd: string
    cloud: AxonCloudClient
    /** The host surface handed to every spawned capsule — supplied by Runtime(). */
    host: AxonHost
    /**
     * The platform's policy decider. Bound per agent here, since a grant is
     * written against an agent NAME and the capsule reports only the fn and
     * its arguments. Absent = no decider, which the capsule treats as deny.
     */
    escalations?: EscalationsT
    /**
     * The control channel this PROCESS is serving, if it serves one.
     *
     * A thunk, not a value: the server binds a port, and construction here is
     * wiring only — the surface that owns the channel (the TUI) starts it when
     * it is ready and this reads whatever is live at spawn time. Headless
     * callers (`axon run`) pass nothing and their records carry no port.
     *
     * Stamped onto EVERY instance this process spawns, deliberately: one
     * process serves one channel, and every conversation inside it is
     * reachable on that one port. Two records naming the same port is not
     * duplication — `TuiSurface.focus(sessionId)` is precisely how a caller
     * picks between the conversations behind it.
     */
    control?: () => { port: number; token: string } | null
}

/**
 * Instances — the registry of running agents.
 *
 * Keyed by sessionId because the session IS the conversation's durable identity
 * (the same project can run twice as two independent conversations). No shared
 * state between instances: the whole point of the multi-instance model is that
 * there is nothing to couple.
 *
 * Owns membership and focus, nothing else. What an agent may spawn (requests.ts)
 * and what sessions exist on disk (sessions/) are separate concerns that read
 * this registry rather than living inside it.
 */
export function Instances(opts: InstancesOpts) {
    const instances = new Map<string, InstanceT>()
    const spawnListeners = new Set<(instance: InstanceT) => void>()
    const stopListeners = new Set<(sessionId: string) => void>()
    let focusedId: string | null = null

    /**
     * sessionId → a monotonic tick stamped every time an instance is focused.
     *
     * Registry state, not a property of an instance: "which of these did I look
     * at last" is a fact about the set, and an instance handed to a caller has
     * no business carrying it. Lets the agent list order by last-used — the
     * behavior you want when ping-ponging between two conversations, where
     * spawn order is the wrong answer after the first switch.
     *
     * A counter rather than Date.now(): two focuses inside the same millisecond
     * must still order, and nothing here needs wall-clock meaning.
     */
    const focusOrder = new Map<string, number>()
    let tick = 0

    function stampFocus(sessionId: string): void {
        focusedId = sessionId
        focusOrder.set(sessionId, ++tick)
    }

    /**
     * Resolve a target to a project.
     *
     * Delegates the string case to Resolve(), which owns every reference
     * form — path, bare name under the active profile, and registry
     * package (fetched and installed on a miss). One resolver, so a
     * spawn and a script's Axon() agree on what "@axon/zeno" means.
     */
    async function resolve(target: ProjectT | string): Promise<ProjectT> {
        if (typeof target !== "string") return target
        const resolved = await opts.resolve.one(target)
        return opts.projects.open(resolved.root)
    }

    /**
     * Boot a project (or a named agent under the active profile) as a new
     * instance and focus it. `session` resumes an existing on-disk session —
     * spawning an already-running sessionId is refused: that conversation is
     * live, focus it instead.
     */
    async function spawn(target: ProjectT | string, spawnOpts: SpawnOpts = {}): Promise<InstanceT> {
        if (spawnOpts?.session && instances.has(spawnOpts.session)) {
            throw err("SESSION_ALREADY_RUNNING", { context: { sessionId: spawnOpts.session } })
        }

        const parent = spawnOpts.parentSessionId ? instances.get(spawnOpts.parentSessionId) : undefined
        if (spawnOpts.parentSessionId && !parent) {
            throw err("PARENT_INSTANCE_NOT_RUNNING", { context: { sessionId: spawnOpts.parentSessionId } })
        }

        const project = await resolve(target)
        // Read at spawn time, not at construction: the TUI starts serving after
        // Platform() exists, so an instance booted later must still get the port.
        const control = opts.control?.() ?? null
        // No prepare() here: Agent() owns the whole pre-runtime sequence
        // now, so it happens inside the build span that reports it. Three
        // call sites used to run it by hand and a caller that forgot got
        // NO_COGNET on first boot.
        const agent = await Agent({
            project: project,
            ...(spawnOpts.job ? { job: spawnOpts.job } : {}),
            ...(spawnOpts.control ? { control: spawnOpts.control } : {}),
            /**
             * AGENTS ARE PROCESSES.
             *
             * Every spawn takes the confined path: `Agent()` builds the
             * blueprint and hands it here, and this boots a real process
             * behind the link. There is no in-heap variant left to choose:
             * `confined` is required, because a runtime in the caller's own
             * heap has no box around it and no policy that can be enforced
             * against it.
             *
             * The TIER still comes from policy: `isolation: "none"` spawns an
             * unboxed process, `"auto"` builds a bwrap box. What changed is
             * that "no box" no longer means "no boundary" — it is still a
             * separate process reached by the six verbs, so the credential and
             * the log stay on this side either way.
             */
            /**
             * SUPERVISION IS THE DAEMON'S.
             *
             * This callback used to assemble the supervisor's services and
             * spawn the box inline — the credential, the session log and the
             * escalation decider all held in whichever process called `spawn`.
             * That made an agent's lifetime and its controllability both
             * properties of its launcher: close the terminal and the agent
             * went with it, and one started headlessly could never be spoken
             * to again.
             *
             * The daemon outlives terminals, so it holds them now. Everything
             * ABOVE this line still happens here — resolve, prepare,
             * blueprint.load(), the build spans — because that is the
             * platform's work and needs the whole project stack. The platform
             * builds; the daemon runs.
             */
            confined: async ({ blueprint, sessionId, rescan }) => {
                if (!opts.daemon) {
                    throw err("AGENT_NO_SUPERVISOR", {
                        detail: "this platform was built without a supervisor, so it cannot boot an agent — construct it with `daemon`",
                        context: { agent: blueprint.agent?.name ?? project.name },
                    })
                }

                const live = await opts.daemon.supervise({
                    sessionId: sessionId,
                    blueprint: blueprint as never,
                    agent: blueprint.agent?.name ?? project.name,
                    projectRoot: project.root,
                    dataRoot: join(project.root, ".agent/data"),
                    // The ownership graph travels with the spawn: the daemon
                    // writes the record, so it needs what the record says.
                    parentSessionId: parent?.sessionId ?? null,
                    rootSessionId: parent?.rootSessionId ?? sessionId,
                    depth: parent ? parent.depth + 1 : 0,
                    ...(spawnOpts.job ? { job: spawnOpts.job } : {}),
                    ...(control ? { control: control } : {}),
                })

                /** The blueprint currently live — replaced by reload(). */
                let current = blueprint

                return {
                    kind: "linked",
                    sessionId: sessionId,
                    link: live.link,
                    session: live.session,
                    bus: live.bus,
                    ...(live.engines ? { engines: live.engines as never } : {}),
                    get blueprint() {
                        return current as never
                    },
                    tier: live.tier,
                    pid: live.pid,
                    /**
                     * A REAL reload: rescan HERE, then send the blueprint
                     * across. The daemon does not scan projects — it has no
                     * project stack and should not grow one — so the platform
                     * pushes the new blueprint rather than the daemon pulling
                     * it.
                     */
                    async reload(): Promise<void> {
                        current = await rescan()
                        await live.link.update(current as never)
                    },
                    async shutdown(): Promise<void> {
                        await live.stop()
                    },
                } as never
            },
            cloud: opts.cloud,
            store: opts.store,
            cwd: opts.cwd,
            host: opts.host,
            // Bound to THIS agent's name, because a grant is written against
            // one and the capsule only ever reports the fn and its arguments —
            // it has no idea which agent it belongs to. Closed over here,
            // where both the project and the decider are in scope.
            ...(opts.escalations
                ? {
                    // The session id is read at CALL time, not closed over:
                    // the agent that owns it does not exist yet at this point
                    // in construction, and a reload can replace the runtime
                    // underneath. Reading through the handle is what keeps a
                    // request naming the session it was actually raised in.
                    escalate: (call: EscalationCall) => opts.escalations!.decide(
                        { agent: project.name, sessionId: agent.sessionId },
                        call,
                    ),
                }
                : {}),
            parentSessionId: parent?.sessionId ?? null,
            ...(parent ? { rootSessionId: parent.rootSessionId } : {}),
            depth: parent ? parent.depth + 1 : 0,
            ...(spawnOpts?.session ? { session: spawnOpts.session } : {}),
            ...(spawnOpts?.onProgress ? { onProgress: spawnOpts.onProgress } : {}),
            ...(spawnOpts?.onTiming ? { onTiming: spawnOpts.onTiming } : {}),
            ...(control ? { control } : {}),
        })

        const sessionId = agent.sessionId
        const instance: InstanceT = {
            sessionId: sessionId,
            parentSessionId: parent?.sessionId ?? null,
            rootSessionId: parent?.rootSessionId ?? sessionId,
            depth: parent ? parent.depth + 1 : 0,
            // Every spawn takes the confined path — `Agent()` calls
            // bootLinked unconditionally — so there is one kind. The "local"
            // branch was for an embedder building Agent() without a `confined`
            // builder, which cannot exist now that one is required.
            source: { kind: "linked" as const, project: project, agent: agent },
        }
        instances.set(instance.sessionId, instance)
        if (spawnOpts.focus !== false) stampFocus(instance.sessionId)
        for (const listener of spawnListeners) listener(instance)
        return instance
    }

    /**
     * Attach to a deployed agent as an instance and focus it.
     *
     * The remote counterpart of spawn(): the deployment is already running, so
     * this binds to it rather than booting anything. attach() hydrates the
     * session, so the returned instance has the agent's real history — a caller
     * renders it exactly as it renders a local one.
     *
     * Re-attaching to a deployment already in the registry focuses the existing
     * instance instead of opening a second binding to the same session. Two
     * handles onto one remote session would both write to it, which breaks the
     * one-session-one-writer rule the remote handle exists to hold.
     */
    async function attach(target: RemoteTarget): Promise<InstanceT> {
        // Keyed on the URL, not the deploymentId: a dev server has no
        // deploymentId, and the URL is what both kinds always have. Normalized
        // so a trailing slash cannot open a second writer onto one session —
        // the rule this guard exists to hold.
        const url = normalizeUrl(target.url)
        const existing = [...instances.values()].find(
            item => item.source.kind === "remote" && normalizeUrl(item.source.target.url) === url,
        )
        if (existing) {
            stampFocus(existing.sessionId)
            return existing
        }

        // agentId drives connect-token minting, and is absent for a local dev
        // server — where the connect gate is open because the agent is already
        // inside its owner's trust boundary. Passing it through conditionally
        // rather than branching: attaching is one operation either way.
        const { axon, sessionId, agent, loaded, engine } = await opts.cloud.attach(url, {
            ...(target.agentId ? { agentId: target.agentId } : {}),
        })

        const instance: InstanceT = {
            sessionId: sessionId,
            // A remote agent is always a root conversation: any agents it runs
            // are its own concern, inside its own capsule.
            parentSessionId: null,
            rootSessionId: sessionId,
            depth: 0,
            source: {
                kind: "remote",
                // The handshake is the only thing that knows what a bare URL is
                // running, so a caller that had no name gets one here rather
                // than rendering a hostname where an identity belongs.
                target: { ...target, url, name: target.name || agent || url, loaded, engine },
                agent: axon,
            },
        }
        instances.set(sessionId, instance)
        stampFocus(sessionId)
        for (const listener of spawnListeners) listener(instance)
        return instance
    }

    /** Shut down one instance. Focus falls to the most recently USED survivor, or null. */
    async function stop(sessionId: string): Promise<void> {
        const owned = children(sessionId)
        await Promise.allSettled(owned.map(child => stop(child.sessionId)))

        const instance = instances.get(sessionId)
        if (!instance) return
        instances.delete(sessionId) // remove first — a failing shutdown() must not leave a caller thinking it's still safely running
        focusOrder.delete(sessionId)
        for (const listener of stopListeners) listener(sessionId)
        if (focusedId === sessionId) {
            // Where you were before this one, not whatever spawned last — after
            // any switching at all those differ, and the spawn-order answer
            // drops you somewhere you never asked for.
            focusedId = byRecency()[0]?.sessionId ?? null
        }
        // A remote instance owns no runtime here — detaching is dropping the
        // handle. The deployed agent keeps running; that is the point of a
        // deployment, and stopping it is a control-plane action, not a close.
        //
        // Everything else DOES get shut down, linked included: it is a real
        // process this supervisor started, and skipping it leaked an agent per
        // stop — the exact orphan the exit handler exists to catch, arriving
        // through the front door.
        if (instance.source.kind !== "remote") await instance.source.agent.shutdown()
    }

    /**
     * One canonical spelling per agent, so the attach guard cannot be defeated
     * by a trailing slash or a capitalized host. Only the parts that are
     * genuinely case-insensitive are lowered — a path can be case-sensitive,
     * and folding it would merge two different agents behind one proxy.
     */
    function normalizeUrl(raw: string): string {
        const trimmed = raw.trim().replace(/\/+$/, "")
        try {
            const parsed = new URL(trimmed)
            const path = parsed.pathname.replace(/\/+$/, "")
            return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${path}`
        } catch {
            // Not parseable as a URL — attach will fail on it with a real
            // network error naming the address, which beats this inventing a
            // complaint about a string it does not understand.
            return trimmed
        }
    }

    function children(parentSessionId: string): InstanceT[] {
        return [...instances.values()].filter(instance => instance.parentSessionId === parentSessionId)
    }

    /**
     * Every instance, most recently focused first. An instance spawned with
     * `focus: false` (an agent-initiated subagent) has never been stamped, so it
     * sorts last — correct: the user has never looked at it.
     */
    function byRecency(): InstanceT[] {
        return [...instances.values()].sort(
            (a, b) => (focusOrder.get(b.sessionId) ?? 0) - (focusOrder.get(a.sessionId) ?? 0),
        )
    }

    function descendants(rootSessionId: string): InstanceT[] {
        return [...instances.values()]
            .filter(instance => instance.rootSessionId === rootSessionId && instance.sessionId !== rootSessionId)
    }

    function focused(): InstanceT | null {
        return focusedId ? instances.get(focusedId) ?? null : null
    }

    return {
        resolve: resolve,
        spawn: spawn,
        attach: attach,
        stop: stop,
        children: children,
        descendants: descendants,
        focused: focused,

        list(): InstanceT[] {
            return [...instances.values()]
        },

        /** Every instance, most recently focused first — what an agent list orders by. */
        recent: byRecency,

        get(sessionId: string): InstanceT | null {
            return instances.get(sessionId) ?? null
        },

        has(sessionId: string): boolean {
            return instances.has(sessionId)
        },

        /** Point the host's main view at a running instance. Pure selection — touches no runtime. */
        focus(sessionId: string): void {
            if (!instances.has(sessionId)) throw err("SESSION_NOT_RUNNING", { context: { sessionId } })
            stampFocus(sessionId)
        },

        /** Shut down every instance — the exit path. Failures don't stop the sweep. */
        async shutdown(): Promise<void> {
            await Promise.allSettled([...instances.keys()].map(id => stop(id)))
        },

        onSpawn(listener: (instance: InstanceT) => void): () => void {
            spawnListeners.add(listener)
            return () => spawnListeners.delete(listener)
        },

        onStop(listener: (sessionId: string) => void): () => void {
            stopListeners.add(listener)
            return () => stopListeners.delete(listener)
        },
    }
}

export type InstancesT = ReturnType<typeof Instances>
