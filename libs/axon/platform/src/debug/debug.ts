import { err } from "@arcforge/err"
import { Events, type Filter } from "./events"
import { Graph, type Reached } from "./graph"
import { Index } from "./indexer"
import { Log } from "./log"
import { Overview } from "./overview"
import { Inference } from "./inference"
import { Perf } from "./perf"
import { Resources } from "./resources"
import { Ring } from "./ring"
import { Sessions } from "./sessions"
import { Signs } from "./signs"

/**
 * Debug — what an agent uses to see inside a recorded or running mind.
 * See README.md beside this file: it is the specification.
 *
 * Every verb takes the agent's directory and, where it is about one
 * session, a reference to it: an id, a prefix of one, or `latest`.
 */
export function Debug() {
    const sessions = Sessions()
    const log = Log()
    const ring = Ring()
    const index = Index({ sessions: sessions, log: log, ring: ring })
    const graph = Graph()
    const perf = Perf()
    const events = Events({ log: log, ring: ring })
    const resources = Resources()
    const inference = Inference()
    const signs = Signs()
    const overview = Overview({ sessions: sessions, index: index, perf: perf, events: events, resources: resources, inference: inference, signs: signs })

    /** The graph a session's mind declared. */
    async function declared(agent: string, ref: string) {
        const session = sessions.resolve(agent, ref)
        const summary = await index.of(agent, session)
        if (!summary.log.declared) throw err("DEBUG_NO_GRAPH", { detail: `session ${session.id} declared no schedule — no cognet ran in it` })
        return { session: session.id, declared: summary.log.declared }
    }

    return {
        sessions: overview.rows,
        session: overview.one,

        graph: {
            /** Every system in run order, and every component. */
            async all(agent: string, ref: string) {
                return declared(agent, ref)
            },

            /** One system, and with a direction, everything it reaches or depends on. */
            async system(agent: string, ref: string, name: string, walk: { direction: "downstream" | "upstream"; depth: number } | null) {
                const found = await declared(agent, ref)
                const system = graph.system(found.declared, name)
                const reached: { downstream?: Reached[]; upstream?: Reached[] } = walk ? { [walk.direction]: graph.walk(found.declared, system.name, walk.direction, walk.depth) } : {}
                return { session: found.session, system: system, ...reached }
            },

            /** One component: its flags, its writers, its readers. */
            async component(agent: string, ref: string, name: string) {
                const found = await declared(agent, ref)
                return { session: found.session, component: graph.component(found.declared, name) }
            },
        },

        /** Everything that went wrong, in order. */
        async errors(agent: string, ref: string) {
            const session = sessions.resolve(agent, ref)
            return { session: session.id, ...events.wrong(await index.of(agent, session)) }
        },

        /** The session's events, filtered. */
        async events(agent: string, ref: string, filter: Filter) {
            const session = sessions.resolve(agent, ref)
            return { session: session.id, ...events.query(session, sessions.data(agent), await index.of(agent, session), filter) }
        },

        /** How long the mind took: its ticks, and each system. */
        async perf(agent: string, ref: string, only?: string) {
            const session = sessions.resolve(agent, ref)
            return { session: session.id, ...perf.of(await index.of(agent, session), only) }
        },

        /** What the agent's processes used: memory and its growth, CPU, GPU, and which threads the CPU went to. */
        async resources(agent: string, ref: string, points: number) {
            const session = sessions.resolve(agent, ref)
            return { session: session.id, ...resources.of(await index.of(agent, session), points) }
        },

        /** The calls the mind made to its models: how often, how long, and how many were waiting on each other. */
        async inference(agent: string, ref: string) {
            const session = sessions.resolve(agent, ref)
            return { session: session.id, ...inference.of(await index.of(agent, session)) }
        },

        prune: sessions.prune,
    }
}

export type DebugT = ReturnType<typeof Debug>
