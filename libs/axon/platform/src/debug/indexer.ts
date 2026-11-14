import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { home, type Decoded } from "@arcforge/session"
import type { LogT } from "./log"
import type { RingT } from "./ring"
import type { SessionsT } from "./sessions"
import { tally } from "./tally"
import type { AgentUsage } from "@arcforge/types"
import type { Channel, Declaration, Event, Fault, Found, Inference, Segment, Summary, Usage } from "./types"

/** Bumped when what the index holds changes shape; an older one is rebuilt. */
const VERSION = 8
/** Faults kept in the index per source; the count is kept whole. */
const FAULTS_KEPT = 500

/**
 * Index — what a session holds, summed once and kept beside it.
 *
 * A session is too large to read for every question, and most questions are
 * about totals: how many errors, how long each system took. So the first
 * question reads the session and writes down the answers; later ones read
 * that.
 *
 * It is extended, never recomputed. The log only grows, so it is read on
 * from the byte the index covers. A telemetry segment that has rolled
 * closed never changes, so it is summed once; the open one is summed again
 * while its size differs. A segment the ring has since deleted is dropped —
 * the index says what is on disk now.
 */
export function Index(opts: { sessions: SessionsT; log: LogT; ring: RingT }) {
    const log = opts.log
    const ring = opts.ring

    return {
        /** The session's summary, brought up to date with what is on disk. */
        async of(agent: string, session: Found): Promise<Summary> {
            const file = opts.sessions.index(agent, session.id)
            const data = opts.sessions.data(agent)
            const header = await home.data.sessions.header(data, session.id)
            const summary = stored.read(file, session, header?.startedAt ?? null) ?? stored.empty(session.id, header?.agentId ?? null, header?.startedAt ?? null)

            let changed = sum.log(summary, session.file, log)

            const present = ring.segments(data, session.id)
            for (const name of Object.keys(summary.segments)) {
                if (!present.some(segment => segment.name === name)) { delete summary.segments[name]; changed = true }
            }
            const hz = summary.log.declared?.hz ?? null
            for (const segment of present) {
                if (summary.segments[segment.name]?.bytes === segment.bytes) continue
                summary.segments[segment.name] = sum.segment(ring.read(segment.file, "typed"), segment.bytes, hz)
                changed = true
            }

            if (changed) {
                mkdirSync(dirname(file), { recursive: true })
                writeFileSync(file, JSON.stringify(summary))
            }
            return summary
        },
    }
}

export type IndexT = ReturnType<typeof Index>

/** Log events the index reads whole; every other is only counted, by its type. */
const READ = new Set(["cognet:schedule:declare", "axon:usage", "cognet:thread:start", "kernel:transform:start", "kernel:transform:complete", "kernel:transform:failed", "kernel:transform:interrupted"])
/** Calls already in flight are counted up to this many; more is counted as this many. */
const BEHIND_MOST = 6

const stored = {
    empty(id: string, agentId: string | null, startedAt: string | null): Summary {
        return {
            version: VERSION, id: id, agentId: agentId, startedAt: startedAt,
            log: { covered: 0, events: 0, torn: 0, firstMs: null, lastMs: null, types: {}, faults: [], faultsTotal: 0, declared: null, usage: { at: [], parts: {}, threads: {}, workers: {}, machine: null }, inference: { roles: {}, behind: new Array<number>(BEHIND_MOST + 1).fill(0), open: {}, firstMs: null, lastMs: null }, channels: {} },
            segments: {},
        }
    },

    /**
     * The index on disk, when it is of this very log: the same version, the
     * same session begun at the same instant, and a log at least as long as
     * what it covers. Anything else is another file's index and is not used.
     */
    read(file: string, session: Found, startedAt: string | null): Summary | null {
        if (!existsSync(file)) return null
        const found = JSON.parse(readFileSync(file, "utf-8")) as Summary
        if (found.version !== VERSION || found.id !== session.id || found.startedAt !== startedAt) return null
        if (statSync(session.file).size < found.log.covered) return null
        return found
    },
}

const sum = {
    /** Reads the log on from where the summary stops. Whether anything was added. */
    log(summary: Summary, file: string, log: LogT): boolean {
        const into = summary.log
        const end = log.scan(file, into.covered, line => {
            const head = log.head(line)
            if (!head) { into.torn++; return }
            if (head.type === "session:header") return
            into.events++
            into.types[head.type] = (into.types[head.type] ?? 0) + 1
            if (head.ms !== null) {
                into.firstMs ??= head.ms
                into.lastMs = head.ms
            }
            const wrong = sum.wrong(head.type)
            const stimulus = head.type.startsWith("cognet:stimulus:")
            if (!wrong && !stimulus && !READ.has(head.type)) return
            const event = log.parse(line)
            if (!event) { into.torn++; return }
            if (stimulus) return sum.heard(into.channels, event)
            if (head.type.startsWith("kernel:transform:")) sum.call(into.inference, event)
            if (head.type === "axon:usage") {
                sum.usage(into.usage, event.data as AgentUsage)
            } else if (head.type === "cognet:thread:start") {
                const started = event.data as { index: number; tid: number | null }
                if (started.tid !== null) into.usage.workers[started.tid] = started.index
            } else if (wrong) {
                into.faultsTotal++
                if (into.faults.length < FAULTS_KEPT) into.faults.push(sum.fault(event))
            } else if (head.type === "cognet:schedule:declare") {
                // A resumed session declares again; the newest is the mind that ran last.
                into.declared = event.data as Declaration
            }
        })
        if (end === into.covered) return false
        into.covered = end
        return true
    },

    /** One stimulus, counted against its channel. */
    heard(into: Record<string, Channel>, event: Event): void {
        const channel = (event.data as { channel?: unknown } | undefined)?.channel
        if (typeof channel !== "string") throw new Error(`a ${event.type} at seq ${event.time.seq} names no channel`)
        const heard = into[channel] ??= { count: 0, firstMs: event.time.ms, lastMs: event.time.ms }
        heard.count++
        heard.lastMs = event.time.ms
    },

    /** One end of a call to the model worker: begun, or ended however it ended. */
    call(into: Inference, event: Event): void {
        const span = (event.context as { spanId?: string } | undefined)?.spanId
        const data = (event.data ?? {}) as { role?: string; durationMs?: number }
        if (!span) return
        into.firstMs ??= event.time.ms
        into.lastMs = event.time.ms
        if (event.type === "kernel:transform:start") {
            into.behind[Math.min(BEHIND_MOST, Object.keys(into.open).length)]!++
            into.open[span] = data.role ?? "unknown"
            return
        }
        const role = data.role ?? into.open[span] ?? "unknown"
        delete into.open[span]
        const counted = into.roles[role] ??= { ...tally.start(), failed: 0 }
        if (typeof data.durationMs === "number") tally.add(counted, data.durationMs)
        if (event.type !== "kernel:transform:complete") counted.failed++
    },

    /** One sample of what the agent's processes used, added to the series. */
    usage(into: Usage, sample: AgentUsage): void {
        const position = into.at.length
        into.at.push(sample.at)
        for (const [name, part] of Object.entries(sample.parts)) {
            // A part first seen now was absent for every sample before.
            const series = into.parts[name] ??= { shared: part.shared, ram: new Array(position).fill(null), cpu: new Array(position).fill(null), gpu: new Array(position).fill(null), vram: new Array(position).fill(null) }
            series.ram.push(part.ram)
            series.cpu.push(part.cpu)
            series.gpu.push(part.gpu)
            series.vram.push(part.vram)
        }
        for (const [name, series] of Object.entries(into.parts)) {
            if (!(name in sample.parts)) for (const list of [series.ram, series.cpu, series.gpu, series.vram]) list.push(null)
        }
        const machine = into.machine ??= { cores: sample.machine.cores, ramTotal: sample.machine.ram.total, cpu: [], busiest: {} }
        machine.cpu.push(sample.machine.cpu)
        // Processes of one name are one group, as threads are: sixteen browser processes are a browser.
        const busy = new Map<string, { processes: number; cores: number }>()
        for (const process of sample.machine.busiest ?? []) {
            const group = busy.get(process.name) ?? { processes: 0, cores: 0 }
            group.processes++
            group.cores += process.cpu
            busy.set(process.name, group)
        }
        for (const [name, group] of busy) {
            const tallied = machine.busiest[name] ??= { threads: 0, samples: 0, totalCores: 0, maxCores: 0 }
            tallied.threads = Math.max(tallied.threads, group.processes)
            tallied.samples++
            tallied.totalCores += group.cores
            if (group.cores > tallied.maxCores) tallied.maxCores = group.cores
        }

        // Threads of one kind are one group: eight pool threads are a pool, and it is the pool that is busy or not.
        const groups = new Map<string, { threads: number; cores: number; measured: boolean }>()
        for (const thread of sample.threads) {
            const worker = into.workers[thread.tid]
            const name = thread.tid === thread.pid ? "main" : worker !== undefined ? `worker ${worker}` : thread.name.replace(/\s*\d+$/, "")
            const group = groups.get(name) ?? { threads: 0, cores: 0, measured: false }
            group.threads++
            if (thread.cpu !== null) { group.cores += thread.cpu; group.measured = true }
            groups.set(name, group)
        }
        for (const [name, group] of groups) {
            const tallied = into.threads[name] ??= { threads: 0, samples: 0, totalCores: 0, maxCores: 0 }
            tallied.threads = Math.max(tallied.threads, group.threads)
            if (!group.measured) continue
            tallied.samples++
            tallied.totalCores += group.cores
            if (group.cores > tallied.maxCores) tallied.maxCores = group.cores
        }
    },

    /** One telemetry segment, summed. `hz` is the mind's own rate, which sets the deadline a tick is held to. */
    segment(events: Decoded[], bytes: number, hz: number | null): Segment {
        const into: Segment = {
            bytes: bytes, events: events.length, firstMs: events[0]?.time.ms ?? 0, lastMs: events[events.length - 1]?.time.ms ?? 0,
            firstTick: Infinity, lastTick: -Infinity, ticks: tally.start(), late: 0, held: {}, main: tally.start(), over: 0, systems: {}, faults: [], faultsTotal: 0, troubles: [],
        }
        const deadline = hz ? 1000 / hz : null
        /** Main-thread time by tick, summed as its runs are met. */
        const held = new Map<number, number>()
        for (const event of events) {
            const data = (event.data ?? {}) as Record<string, any>
            if (typeof data.tick === "number") {
                if (data.tick < into.firstTick) into.firstTick = data.tick
                if (data.tick > into.lastTick) into.lastTick = data.tick
            }
            if (event.type === "cognet:tick:complete") {
                tally.add(into.ticks, data.durationMs)
                if (deadline !== null && data.durationMs > deadline) into.late++
                for (const one of Array.isArray(data.held) ? data.held : []) {
                    if (typeof one?.system !== "string" || typeof one?.ms !== "number") continue
                    tally.add(into.held[one.system] ??= tally.start(), one.ms)
                }
            } else if (event.type === "cognet:system:run") {
                const system = into.systems[data.system] ??= { ...tally.start(), failed: 0, async: false, threads: [] }
                tally.add(system, data.durationMs)
                if (data.async) system.async = true
                if (typeof data.thread === "number" && !system.threads.includes(data.thread)) system.threads.push(data.thread)
                if (data.outcome !== "complete") system.failed++
                if (!data.async && typeof data.thread !== "number") held.set(data.tick, (held.get(data.tick) ?? 0) + data.durationMs)
            } else if (sum.trouble(event.type, data.component)) {
                const opened = event.type !== "cognet:component:remove"
                into.troubles.push({ at: event.time.ms, tick: data.tick, entity: data.entity, opened: opened, ...(opened ? { what: data.value?.what, detail: data.value?.detail } : {}) })
            }
            if (sum.wrong(event.type) || (event.type === "cognet:system:run" && data.outcome !== "complete")) {
                into.faultsTotal++
                if (into.faults.length < FAULTS_KEPT) into.faults.push(sum.fault(event))
            }
        }
        for (const ms of held.values()) {
            tally.add(into.main, ms)
            if (deadline !== null && ms > deadline) into.over++
        }
        if (into.firstTick === Infinity) { into.firstTick = -1; into.lastTick = -1 }
        return into
    },

    /**
     * Whether an event of this type says something went wrong. A build
     * warning counts: a plugin that could not be imported is reported as
     * one, and the agent then runs without it — Terry ran blind that way.
     */
    wrong(type: string): boolean {
        return type.endsWith(":failed") || type.endsWith(":error") || type === "build:warning"
    },

    /** Whether an event writes or removes a trouble: a component named `trouble`, by the convention a cognet reports its own faults with. */
    trouble(type: string, component: unknown): boolean {
        if (!type.startsWith("cognet:component:") || typeof component !== "string") return false
        return component === "trouble" || component.endsWith("/trouble")
    },

    fault(event: { type: string; time: { ms: number; seq: number }; data?: unknown }): Fault {
        const data = (event.data ?? {}) as Record<string, any>
        const message = data.error?.message ?? data.message
        return {
            at: event.time.ms, seq: event.time.seq, type: event.type,
            ...(typeof data.tick === "number" ? { tick: data.tick } : {}),
            ...(typeof data.system === "string" ? { system: data.system } : {}),
            ...(typeof data.error?.code === "string" ? { code: data.error.code } : {}),
            ...(typeof message === "string" ? { message: message } : {}),
        }
    },
}
