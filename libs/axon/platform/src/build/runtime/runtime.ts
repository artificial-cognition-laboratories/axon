import type { AxonHost, AxonT } from "@arcforge/core"
import type { AxonBlueprint } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"
import type { AxonCloudClient } from "@arcforge/cloud"
import type { StoreT } from "../../services/store"
import type { ProjectT, ProjectsT } from "../project"
import type { AgentT } from "./agent"
import { type AgentSupervisor, Instances, type InstanceT } from "./instances"
import { Resolve } from "./resolve"
import { Requests } from "./requests"
import { Escalations } from "./escalations"
import { Sessions } from "./sessions"
import { Zeno } from "./zeno"

type RuntimeOpts = {
    /**
     * Who supervises a spawned agent.
     *
     * Threaded from the top because only the process root knows which daemon
     * it is talking to — a local `Axond()`, or a socket client pointed at one
     * that is already running. Constructing one here would give every
     * Runtime() its own supervisor and defeat the point.
     *
     * Optional: see PlatformOpts.daemon. `spawn` refuses without it.
     */
    daemon?: AgentSupervisor
    store: StoreT
    projects: ProjectsT
    /** Platform invocation directory inherited by every spawned capsule. */
    cwd: string
    /** The platform's authenticated cloud client, handed to every spawned agent. */
    cloud: AxonCloudClient
    /** Fetches and prepares a published artifact — how zeno arrives. */
    clone: (ref: string, cwd: string, options?: { dir?: string }) => Promise<{ root: string }>
    /** This process's control channel, if it serves one — see InstancesOpts.control. */
    control?: () => { port: number; token: string } | null
}

/**
 * Runtime — every agent running on this machine, and what the host addresses.
 *
 * Composition only. The concerns underneath it:
 *   instances — the registry: spawn, attach, stop, focus, membership
 *   requests  — the host surface a running agent calls into, and its limits
 *   sessions  — the resumable conversations on disk
 *   zeno      — the default agent, guaranteed to exist
 *
 * The surface below is deliberately flat and unchanged from the Agents() it
 * replaced: consumers (the TUI's composables, the CLI) address instances by
 * sessionId and read focused projections, and none of them should have to learn
 * a new shape because the implementation grew leaves.
 */
export function Runtime(opts: RuntimeOpts) {
    // instances needs a host to hand every capsule; requests needs the registry
    // to spawn into. The host closes over `requests` rather than being passed a
    // value, so neither has to exist before the other — construction stays pure
    // wiring, and nothing here calls anything.
    // One resolver for every agent reference in this process — a spawn, a
    // script's Axon(), and a fleet member all agree on what a string means.
    const resolve = Resolve({ store: opts.store, cwd: opts.cwd })

    const escalations = Escalations({ store: opts.store })

    const instances = Instances({
        ...(opts.daemon ? { daemon: opts.daemon } : {}),
        store: opts.store,
        projects: opts.projects,
        resolve: resolve,
        cwd: opts.cwd,
        cloud: opts.cloud,
        host: { call: input => requests.call(input) },
        escalations: escalations,
        ...(opts.control ? { control: opts.control } : {}),
    })

    const requests = Requests({ instances: instances })
    const sessions = Sessions({ store: opts.store, isRunning: id => instances.has(id) })
    const zeno = Zeno({ store: opts.store, projects: opts.projects, clone: opts.clone })

    return {
        /**
         * A target to a project handle: a path, or a bare name under the active
         * profile. Exposed because callers that do not spawn — a headless
         * `axon run` — still need to name an agent rather than infer it from cwd.
         */
        resolve: instances.resolve,

        /**
         * The host surface a running agent calls into — one agent asking the
         * platform to run work on another. Exposed because it is a real part of
         * what a runtime provides, and because its limits (depth, fan-out,
         * total descendants) are the only guard against an agent spawning
         * without bound: they need to be reachable to be verified.
         */
        host: requests,

        /**
         * The policy decider — where a surface registers to answer "may I?".
         *
         * Exposed because WHICH surface answers is not this module's business:
         * the TUI attaches when it boots, the CLI may attach for one command,
         * and a headless run attaches nothing at all. Each is a client of the
         * same store, so an escalation approved in one is visible in the rest.
         */
        escalations: escalations,


        spawn: instances.spawn,
        attach: instances.attach,
        focus: instances.focus,
        stop: instances.stop,
        shutdown: instances.shutdown,
        children: instances.children,
        onSpawn: instances.onSpawn,
        onStop: instances.onStop,

        /** Every running instance, spawn order. */
        list: instances.list,

        /** Every running instance, most recently focused first. */
        recent: instances.recent,

        get(sessionId: string): InstanceT | null {
            return instances.get(sessionId)
        },

        /** Every on-disk session across the active profile's agents, newest first. */
        sessions(): ReturnType<typeof sessions.list> {
            return sessions.list()
        },

        /**
         * The session store itself — fork, rename, list.
         *
         * Exposed alongside `sessions()` rather than replacing it: that method
         * is the hot read every UI does, and dozens of call sites spell it. The
         * handle is for the verbs that act on ONE log, which no caller needed
         * until forking existed.
         */
        get history(): typeof sessions {
            return sessions
        },

        /**
         * The default agent — always present, so the TUI always has somewhere
         * to send a first message. An ordinary project once scaffolded.
         */
        zeno: zeno,

        /** The focused instance, or null when nothing is running. */
        get focused(): InstanceT | null {
            return instances.focused()
        },

        // ── focused projections — what the host's main view addresses ───────

        /**
         * The focused agent handle, whichever kind it is.
         *
         * `AgentT` is the UNION now, and both variants carry the lifecycle
         * verbs every caller here actually wants — `reload`, `shutdown`,
         * `sessionId`. Returning null for a linked agent was reading the old
         * meaning of the type into the new one: it made `agents.current`
         * null for every agent the platform spawns, since spawning produces
         * linked ones.
         *
         * A caller needing an in-heap ORGAN (`current.axon`, `current.kernel`)
         * narrows on `kind === "process"` and gets a compile error if it
         * forgets — which is the whole reason the union is discriminated.
         * Null still means "nothing focused, or it is a deployment".
         */
        get current(): AgentT | null {
            const instance = instances.focused()
            if (!instance || instance.source.kind === "remote") return null
            return instance.source.agent
        },

        /**
         * The project backing the focused instance.
         *
         * BOTH local kinds have one: a linked agent runs from source on this
         * machine, it merely runs in its own process. Only a deployment has no
         * project — it has an address instead.
         *
         * This checked `kind === "local"` and so went blank the moment agents
         * became processes, taking the header's `home` row with it. The
         * question a caller is asking here is "is there a directory", not "is
         * the runtime in my heap".
         */
        get project(): ProjectT | null {
            const instance = instances.focused()
            if (!instance || instance.source.kind === "remote") return null
            return instance.source.project
        },

        get active(): boolean {
            return instances.focused() !== null
        },

        /**
         * The focused agent's BLUEPRINT — what it is, however it runs.
         *
         * Separate from `runtime` because it is the one thing every surface
         * needs and the boundary does not hide: the supervisor prepares the
         * blueprint and holds it. A header rendering the agent's name, its
         * home and what it is carrying reads this, rather than reaching
         * across the link for facts this side already wrote.
         *
         * Null only for a deployment, which genuinely has no local project.
         */
        get blueprint(): AxonBlueprint | null {
            const instance = instances.focused()
            if (!instance || instance.source.kind === "remote") return null
            return instance.source.agent.blueprint
        },

        /**
         * The focused agent's SESSION — the durable record, however it runs.
         *
         * Held by the SUPERVISOR — the agent appends through commit and can
         * never rewrite it — so every log projection reads the same record
         * the agent is writing into.
         */
        get session(): AxonSessionT | null {
            const instance = instances.focused()
            if (!instance || instance.source.kind === "remote") return null
            return instance.source.agent.session
        },

    }
}

export type RuntimeT = ReturnType<typeof Runtime>
