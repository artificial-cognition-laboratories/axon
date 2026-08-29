import { err } from "@arcforge/err"
import { DirectHandle } from "./handle"
import { Instance, type InstanceT } from "./instance"
import { Registry } from "./registry"
import type { Supervised, SuperviseT } from "./supervise"
import type { AxonBlueprint } from "@arcforge/types"
import type { AgentRecord, AgentsState } from "./types"

/**
 * What booting one agent needs.
 *
 * The identity fields (`parentSessionId`, `rootSessionId`, `depth`) describe
 * the OWNERSHIP GRAPH, not the process — an agent spawned by another agent is
 * a child, and readers nest on it. They travel with the spawn because the
 * daemon is the only thing that sees every one, and therefore the only thing
 * that can record the tree without gaps.
 */
export type SuperviseInput = {
    sessionId: string
    /** Already normalised and prepared — the platform's work, not the daemon's. */
    blueprint: AxonBlueprint
    /** The agent's name. Grants and records are written against it. */
    agent: string
    projectRoot: string
    dataRoot: string
    /** Null for a root agent; the spawner's session for a subagent. */
    parentSessionId?: string | null
    /** The top of this agent's tree. Defaults to its own session. */
    rootSessionId?: string
    /** How deep in that tree. Defaults to 0. */
    depth?: number
    /** The work item this run answers, when one asked. Correlation only. */
    job?: string
    /**
     * A control channel the SPAWNER is serving, published so a reader can find
     * it. Stored verbatim — the daemon never speaks this protocol.
     */
    control?: { port: number; token: string }
}

export type AgentsOpts = {
    /**
     * Holds the provider credential, for supervising agents.
     *
     * Optional: a daemon reading the registry needs none, and requiring one
     * would make `axond agents` fail on a machine nobody has logged into.
     * `spawn` is what refuses when it is absent.
     */
    supervise?: SuperviseT
    /**
     * This machine's id, read fresh per call.
     *
     * A THUNK because identity is the machine domain's to own, and the agents
     * domain should not probe a second time — nor cache an answer taken before
     * that domain was ready. Null travels through: a machine that cannot be
     * identified says so rather than inventing one.
     */
    machineId?: () => string | null
    /** Where records are written. Tests point this at a scratch dir. */
    root?: string
    /** Read only `root`, ignoring the machine's real stores. Tests only — see Registry. */
    isolated?: boolean
}

/**
 * Agents — every agent running on this machine.
 *
 * ── Observing, not yet owning ───────────────────────────────────────────────
 *
 * The daemon reads the records agents publish for themselves; the platform
 * still spawns and supervises them. That order is deliberate — moving
 * observation first means Fleet and the TUI can ask the daemon "what is
 * running" against a real answer, while the far riskier move (who holds
 * provider credentials, who owns the process) lands separately with something
 * working to compare against.
 *
 * `at(id)` already returns a HANDLE rather than a record, and the verbs
 * supervision will fill throw meanwhile. That is what stops the SDK needing a
 * translation layer once they work.
 *
 * ── Why the daemon is the right owner ───────────────────────────────────────
 *
 * The platform answers "is this running" from an in-process Map — which is
 * per-process state describing a machine-wide fact. Every surface that did not
 * spawn the agent (the Fleet extension host, a second terminal) reads that map
 * as empty and reports a live agent as stopped. A single long-lived process
 * reading one registry is the answer that is true for everyone.
 */
export function Agents(opts: AgentsOpts = {}) {
    /**
     * The agents this daemon is supervising, by session id.
     *
     * Held for the AGENT'S lifetime, not the caller's — which is the whole
     * point: a link owned by the terminal that asked for the spawn dies with
     * that terminal, and an agent that cannot outlive its launcher can never
     * be a boot-time agent or a scheduled one.
     */
    const supervised = new Map<string, Supervised>()

    const registry = Registry({
        ...(opts.root !== undefined ? { root: opts.root } : {}),
        ...(opts.isolated !== undefined ? { isolated: opts.isolated } : {}),
    })

    /** Stamp the machine onto a record — see AgentRecord for why it is explicit. */
    function decorate(instance: AgentRecord | { sessionId: string }): AgentRecord {
        return { ...(instance as AgentRecord), machineId: opts.machineId?.() ?? null }
    }

    /**
     * Signal one agent's process.
     *
     * Owned here rather than by the registry: the registry's concern is the
     * RECORD, and a leaf that both tracked processes and killed them would be
     * two responsibilities behind one name.
     */
    function signal(sessionId: string, sig: NodeJS.Signals): boolean {
        // An agent THIS daemon supervises is shut down through its link, not
        // signalled: the link drains the wake and closes the session log,
        // where a signal leaves both hanging.
        const live = supervised.get(sessionId)
        if (live) {
            supervised.delete(sessionId)
            registry.stop(sessionId)
            void live.stop()
            return true
        }

        const record = registry.get(sessionId)
        if (!record) return false

        try {
            // The process GROUP, not the pid: an agent is a launcher plus the
            // runtime it spawned, and signalling the launcher alone leaves the
            // runtime orphaned and still holding the GPU.
            process.kill(-record.pid, sig)
            return true
        } catch {
            // A pid that vanished between the read and the signal is a race
            // with normal shutdown, not a fault — the caller asked for it to
            // stop and it has.
            return false
        }
    }

    return {
        registry: registry,

        /** Every agent running on this machine, newest first. */
        list(): AgentRecord[] {
            return registry.list().map(decorate)
        },

        /** One agent, as a handle. Null when nothing by that id is running. */
        at(sessionId: string): InstanceT | null {
            const record = registry.get(sessionId)
            if (!record) return null

            // A handle only when THIS daemon supervises it. An agent booted
            // by a terminal that still holds its own link is observable and
            // not reachable — see Instance.contract().
            const live = supervised.get(sessionId)

            return Instance({
                record: decorate(record),
                refresh: id => {
                    const found = registry.get(id)
                    return found ? decorate(found) : null
                },
                signal: signal,
                ...(live ? { handle: DirectHandle(live) } : {}),
            })
        },

        /** Everything the domain reports in one read — what a client's `state()` calls. */
        state(): AgentsState {
            return { agents: this.list(), roots: registry.roots }
        },

        /**
         * Stop one agent. False when nothing by that id was running.
         *
         * A verb on the domain as well as on the handle, because a caller with
         * an id and no handle should not have to build one to act.
         */
        stop(sessionId: string): boolean {
            return signal(sessionId, "SIGTERM")
        },

        /** Subscribe to the live list. Returns an unsubscribe. */
        watch(listener: (agents: AgentRecord[]) => void): () => void {
            return registry.watch(instances => listener(instances.map(decorate)))
        },

        /**
         * Boot an agent, supervised by this daemon.
         *
         * Takes a PREPARED blueprint, never an agent reference. Resolving a
         * reference means opening a project and preparing it, which is the
         * platform's whole build stack — a daemon that did that would be the
         * platform with a socket attached. The platform resolves and prepares;
         * the daemon hosts.
         *
         * The record is published AFTER the agent is up, so a reader never
         * sees "running" for a process that failed to boot. The supervisor is
         * held for the agent's lifetime — that is what lets it outlive the
         * terminal that asked for it.
         */
        /**
         * Boot an agent and return the SUPERVISOR's handle on it.
         *
         * Distinct from `at(id)`, which returns the consumer-facing
         * `Instance`. This is what the platform's `confined` seam consumes: it
         * needs the link, the session and the bus to assemble the runtime its
         * own surfaces expect, and those are supervisor-side objects rather
         * than anything a client should hold.
         *
         * Named `supervise` for that reason — "spawn" would suggest the
         * caller gets an agent to talk to, and what it gets is the machinery
         * behind one.
         */
        async supervise(input: SuperviseInput): Promise<Supervised> {
            if (!opts.supervise) {
                throw err("DAEMON_NOT_WIRED", {
                    detail: "this daemon has no credential and cannot supervise — it was built without one",
                })
            }

            const live = await opts.supervise.spawn({
                sessionId: input.sessionId,
                blueprint: input.blueprint,
                agent: input.agent,
            })
            supervised.set(input.sessionId, live)

            registry.start({
                // The AGENT's pid, not this process's: a reader probes it to
                // decide whether the session is alive, and reporting the
                // daemon's would keep a dead agent looking healthy for as long
                // as the daemon ran.
                pid: live.pid,
                sessionId: input.sessionId,
                agentName: input.agent,
                projectRoot: input.projectRoot,
                dataRoot: input.dataRoot,
                // The ownership graph. Carried rather than derived: an agent
                // spawned by another agent is a child, readers nest on it, and
                // the runtime enforces depth limits against it. The daemon is
                // the only thing that sees every spawn, so it is the only
                // thing that can record the tree correctly.
                parentSessionId: input.parentSessionId ?? null,
                rootSessionId: input.rootSessionId ?? input.sessionId,
                depth: input.depth ?? 0,
                ...(input.job ? { job: input.job } : {}),
                // Passed THROUGH, never interpreted: a control channel belongs
                // to the surface serving it, and the daemon's part is only to
                // publish where it is so a reader can find it.
                ...(input.control ? { control: input.control } : {}),
                startedAt: new Date().toISOString(),
            })

            return live
        },

        /**
         * Boot an agent and return a handle to TALK to it.
         *
         * The consumer-facing counterpart of `supervise`. Same boot, different
         * return: this is what an SDK caller wants, and what a socket client
         * can serve.
         */
        async spawn(input: SuperviseInput): Promise<InstanceT> {
            await this.supervise(input)
            return this.at(input.sessionId)!
        },

        /**
         * Shut down every supervised agent, then release the watchers.
         *
         * Agents first: a daemon that exits leaving them running orphans every
         * one — no supervisor means no inference, so they would be alive and
         * unable to think.
         */
        async dispose(): Promise<void> {
            await Promise.all([...supervised.values()].map(async live => {
                registry.stop(live.sessionId)
                await live.stop()
            }))
            supervised.clear()
            registry.dispose()
        },
    }
}

export type AgentsT = ReturnType<typeof Agents>
