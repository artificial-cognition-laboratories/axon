import { home } from "@arcforge/session"
import type { EventsT } from "./events"
import type { IndexT } from "./indexer"
import type { InferenceT } from "./inference"
import type { PerfT } from "./perf"
import type { ResourcesT } from "./resources"
import type { SessionsT } from "./sessions"
import type { SignsT } from "./signs"

/** Systems shown in a session's overview, and readings of each memory series. */
const COSTLIEST = 5
const POINTS = 8

/**
 * Overview — sessions at a glance: the list of them, and one on one screen.
 * What to run first when something is said to be wrong.
 */
export function Overview(opts: { sessions: SessionsT; index: IndexT; perf: PerfT; events: EventsT; resources: ResourcesT; inference: InferenceT; signs: SignsT }) {
    const sessions = opts.sessions

    return {
        /**
         * The newest sessions. Read from each one's header and the
         * filesystem alone, so listing costs nothing however large they
         * are; what a session HOLDS is `one`.
         */
        async rows(agent: string, limit: number) {
            const all = sessions.list(agent)
            const data = sessions.data(agent)
            const rows = []
            for (const session of all.slice(0, limit)) {
                const header = await home.data.sessions.header(data, session.id)
                const startedAt = header ? Date.parse(header.startedAt) : null
                rows.push({
                    id: session.id,
                    startedAt: header?.startedAt ?? null,
                    lastWrittenAt: new Date(session.modifiedAt).toISOString(),
                    seconds: startedAt === null ? null : Math.round((session.modifiedAt - startedAt) / 1000),
                    bytes: sessions.sizes(agent, session.id),
                })
            }
            return { sessions: rows, total: all.length }
        },

        /** One session: how long, how it ran, what went wrong, what cost most, what it holds on disk. */
        async one(agent: string, ref: string) {
            const session = sessions.resolve(agent, ref)
            const summary = await opts.index.of(agent, session)
            const perf = opts.perf.of(summary)
            const wrong = opts.events.wrong(summary)
            const resources = opts.resources.of(summary, POINTS)
            const inference = opts.inference.of(summary)
            const faults = { total: wrong.faultsTotal, first: wrong.faults[0] ?? null }
            const declared = summary.log.declared
            return {
                id: session.id,
                // What says this session is not well. Nothing found is every check passing, and `checked` says which.
                signs: opts.signs.of({ faults: faults, troubles: wrong.troubles, ticks: perf.ticks, held: perf.held, systems: perf.systems, parts: resources.parts, machine: resources.machine, inference: inference, senses: { channels: summary.log.channels, lastMs: summary.log.lastMs } }),
                agentId: summary.agentId,
                startedAt: summary.startedAt,
                lastWrittenAt: new Date(session.modifiedAt).toISOString(),
                seconds: summary.log.firstMs !== null && summary.log.lastMs !== null ? Math.round((summary.log.lastMs - summary.log.firstMs) / 1000) : null,
                mind: declared ? { systems: declared.systems.length, components: declared.components.length, targetPerSecond: declared.hz ?? null } : null,
                log: { events: summary.log.events, torn: summary.log.torn },
                // Telemetry is a window: these are of the last stretch of the session, not all of it.
                telemetry: { window: perf.window, ticks: perf.ticks },
                faults: faults,
                troubles: { opened: wrong.troubles.filter(trouble => trouble.opened).length },
                costliest: perf.systems.slice(0, COSTLIEST),
                // Over the whole session, from the usage samples in the log.
                resources: { machine: resources.machine, parts: resources.parts, threads: resources.threads.slice(0, COSTLIEST) },
                bytes: sessions.sizes(agent, session.id),
            }
        },
    }
}

export type OverviewT = ReturnType<typeof Overview>
