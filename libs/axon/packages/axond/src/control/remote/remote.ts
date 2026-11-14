import { err } from "@arcforge/err"
import type { AgentRecord, AgentsT, InstalledAgent } from "../../agents/index"
import type { MachineState, MachineT } from "../../machine/index"
import type { ModelRecord, ModelsT } from "../../models/index"
import type { AgentSchedule, ScheduleT } from "../../schedule/index"
import type { Peer, RemoteAgent, RemoteMachine, RemoteModel, RemoteModels, RemoteProject, RemoteSchedule } from "./types"

type RemoteOpts = {
    /** The verified caller. Built per authenticated connection, so every verb knows who asked. */
    peer: Peer
    agents: AgentsT
    machine: MachineT
    models: ModelsT
    schedule: ScheduleT
}

/**
 * Remote — the verbs another machine may call on this one.
 *
 * ── The shape IS the allowlist ──────────────────────────────────────────────
 *
 * The network dispatches over this object and nothing else, so a verb is
 * reachable from another machine exactly when it is written here. The local
 * socket's domains are never handed to the network: their surface is every
 * function the daemon has, and that is not a surface to publish.
 *
 * ── Every answer is shaped on the way out ───────────────────────────────────
 *
 * Each verb calls a domain and returns a wire type (`./types`), copied field
 * by field. Domain records carry things that must never leave the box — an
 * agent's control token, its pid, local paths — and returning the record
 * would send whatever it holds today or grows tomorrow.
 *
 * ── It speaks for this distribution only ────────────────────────────────────
 *
 * Fleet reads both stores to describe the whole machine. A remote caller is
 * talking to ONE daemon, and dev and prod are separate networks, so every
 * inventory here reads `agents.own`.
 */
export function Remote(opts: RemoteOpts) {
    return {
        machine: {
            state: async (): Promise<RemoteMachine> => wire.machine(opts.machine.state()),
        },
        agents: {
            list: async (): Promise<RemoteAgent[]> => opts.agents.own.list().map(wire.agent),
            installed: async (): Promise<RemoteProject[]> => opts.agents.own.installed().map(wire.project),
            /**
             * Stop one of this store's agents. False when it had already gone.
             *
             * Refused, not false, for a session this store does not own: the
             * caller named something that is not theirs to name from here, and
             * a quiet false would read as "it stopped by itself".
             */
            async stop(input: { session: string }): Promise<boolean> {
                if (!opts.agents.own.list().some(record => record.sessionId === input.session)) {
                    throw err("AGENT_NOT_FOUND", {
                        detail: `no agent with session ${input.session} is running in this machine's store`,
                        context: { session: input.session, peer: opts.peer.machine },
                    })
                }
                return opts.agents.stop(input.session)
            },
        },
        schedule: {
            list: async (): Promise<RemoteSchedule[]> => opts.schedule.list().map(wire.schedule),
            pause: async (input: { id: string }): Promise<RemoteSchedule> => wire.schedule(opts.schedule.pause(input.id)),
            resume: async (input: { id: string }): Promise<RemoteSchedule> => wire.schedule(opts.schedule.resume(input.id)),
        },
        models: {
            async state(): Promise<RemoteModels> {
                const state = await opts.models.state()
                return { cached: state.cached.map(wire.model), resident: state.resident.map(wire.model) }
            },
        },
    }
}

export type RemoteT = ReturnType<typeof Remote>

/** Domain record → wire shape, one per kind. The only place a field is chosen to cross. */
const wire = {
    machine(state: MachineState): RemoteMachine {
        return {
            hostname: state.identity.hostname,
            platform: state.identity.platform,
            arch: state.identity.arch,
            capacity: state.capacity,
            usage: state.usage,
            budget: state.budget,
            held: state.held,
            samples: state.samples,
        }
    },
    agent(record: AgentRecord): RemoteAgent {
        return {
            session: record.sessionId,
            name: record.agentName,
            startedAt: record.startedAt,
            parent: record.parentSessionId ?? null,
            job: record.job ?? null,
        }
    },
    project(project: InstalledAgent): RemoteProject {
        return { ref: project.ref, version: project.version, profile: project.profile, usedAt: project.usedAt }
    },
    schedule(schedule: AgentSchedule): RemoteSchedule {
        return {
            id: schedule.id,
            agent: schedule.agent,
            every: schedule.every,
            paused: schedule.paused,
            lastRunAt: schedule.lastRunAt,
            lastResult: schedule.lastResult,
            error: schedule.error ?? null,
        }
    },
    model(model: ModelRecord): RemoteModel {
        return {
            id: model.id,
            name: model.name,
            owner: model.owner,
            bytes: model.bytes,
            resident: model.resident,
            device: model.device ?? null,
        }
    },
}
