import type { Channel, Fault, Trouble } from "./types"

/**
 * What counts as a sign. A mind under nine tenths of its rate is slow; one
 * tick in fifty over the deadline is a deadline being missed — on the main
 * thread (`deadline`), or start to end, waiting on workers and lagged runs
 * included (`late`, which names what it waited on); memory still
 * rising ten megabytes a minute over the later half of a session is growth
 * worth a look — memory that rose and levelled off is not. A machine busy
 * past ninety percent on average has nothing left to give the mind, and
 * every other number here is measured under that. Model calls whose
 * durations add up to nine tenths of the time they were made in are a
 * worker with no slack: past that they are waiting on each other. A sense
 * heard at least twenty times that then falls silent for twenty of its own
 * usual gaps — and at least ten seconds — before the session ends has gone
 * quiet: a body lost, a cable dropped, while the mind ran on regardless.
 */
const LIMITS = { rate: 0.9, over: 0.02, growthMb: 10, machine: 90, busy: 0.9, quiet: { heard: 20, gaps: 20, leastMs: 10_000 } }

export type Sign = { sign: "faults" | "failing" | "slow" | "deadline" | "late" | "memory" | "saturated" | "inference" | "troubles" | "quiet"; detail: string }

type Seen = {
    faults: { total: number; first: Fault | null }
    troubles: Trouble[]
    ticks: { perSecond: number; targetPerSecond: number | null; targetMs: number | null; wall: { runs: number; maxMs: number }; late: number; main: { runs: number; maxMs: number }; overTarget: number }
    /** The systems ticks waited on, longest wait first. */
    held: Array<{ system: string; ticks: number; totalMs: number; maxMs: number }>
    systems: Array<{ system: string; runs: number; failed: number }>
    parts: Record<string, { shared: boolean; ramMb: { first: number; last: number; peak: number; perMinuteLately: number | null } | null; cpuCores: { mean: number } | null }>
    machine: { cores: number; cpuPercent: { mean: number } | null; busiest: Array<{ process: string; meanCores: number }> } | null
    inference: { busy: number | null; calls: number; behind: Array<{ already: number; calls: number }>; roles: Array<{ role: string; perSecond: number | null; p50Ms: number; busy: number | null }> }
    /** Every stimulus channel heard, and when the session's log last heard anything at all. */
    senses: { channels: Record<string, Channel>; lastMs: number | null }
}

/**
 * Signs — the things that say a session is not well, read off what the
 * other leaves measured. Each is one line, so one command says whether to
 * look further and where.
 *
 * `checked` is every sign that was looked for: a sign missing from `found`
 * is one that was checked and was fine, not one nobody looked at.
 */
export function Signs() {
    return {
        of(seen: Seen): { found: Sign[]; checked: Sign["sign"][] } {
            const found: Sign[] = []
            const { ticks } = seen

            if (seen.faults.total > 0) {
                const first = seen.faults.first
                found.push({ sign: "faults", detail: `${seen.faults.total} faults; the first: ${first ? `${first.type}${first.message ? ` — ${first.message}` : ""}` : "not kept"}` })
            }

            const failing = seen.systems.filter(system => system.failed > 0)
            if (failing.length) found.push({ sign: "failing", detail: failing.map(system => `${system.system} failed ${system.failed} of ${system.runs} runs`).join("; ") })

            if (ticks.targetPerSecond !== null && ticks.main.runs > 0 && ticks.perSecond < ticks.targetPerSecond * LIMITS.rate) {
                found.push({ sign: "slow", detail: `${ticks.perSecond} ticks a second against a target of ${ticks.targetPerSecond}` })
            }

            if (ticks.main.runs > 0 && ticks.overTarget / ticks.main.runs > LIMITS.over) {
                found.push({ sign: "deadline", detail: `${ticks.overTarget} of ${ticks.main.runs} ticks held the main thread past ${ticks.targetMs}ms; the worst ${ticks.main.maxMs}ms` })
            }

            // Late by the clock, not only the main thread: a worker or a lagged run the tick waited on counts.
            if (ticks.wall.runs > 0 && ticks.late / ticks.wall.runs > LIMITS.over) {
                const by = seen.held.slice(0, 3).map(one => `${one.system} for ${span(one.totalMs)} over ${one.ticks} ${one.ticks === 1 ? "tick" : "ticks"} (the worst ${one.maxMs}ms)`)
                found.push({ sign: "late", detail: `${ticks.late} of ${ticks.wall.runs} ticks ran past ${ticks.targetMs}ms, the worst ${ticks.wall.maxMs}ms; ${by.length ? `held by ${by.join(", ")}` : "held by no system — the time was the tick's own"}` })
            }

            for (const [name, part] of Object.entries(seen.parts)) {
                const ram = part.ramMb
                if (!ram || ram.perMinuteLately === null || ram.perMinuteLately < LIMITS.growthMb) continue
                found.push({ sign: "memory", detail: `${name}${part.shared ? " (shared)" : ""} is still growing, ${ram.perMinuteLately}MB a minute: ${ram.first}MB at first, ${ram.last}MB now, ${ram.peak}MB at most` })
            }

            const machine = seen.machine
            if (machine?.cpuPercent && machine.cpuPercent.mean >= LIMITS.machine) {
                const own = Object.entries(seen.parts).flatMap(([name, part]) => (part.cpuCores ? [`${name} ${part.cpuCores.mean}`] : []))
                const busiest = machine.busiest.slice(0, 4).map(process => `${process.process} ${process.meanCores}`)
                found.push({ sign: "saturated", detail: `the machine was ${Math.round(machine.cpuPercent.mean)}% busy across ${machine.cores} cores; this agent's parts, in cores: ${own.join(", ") || "unmeasured"}; the busiest processes on the machine: ${busiest.join(", ") || "not recorded in this session"}` })
            }

            const asked = seen.inference
            if (asked.busy !== null && asked.busy >= LIMITS.busy) {
                const free = asked.behind.find(row => row.already === 0)?.calls ?? 0
                found.push({ sign: "inference", detail: `model calls took ${asked.busy} of the time they were made in — more than one worker has; ${free} of ${asked.calls} began with the worker free; ${asked.roles.map(role => `${role.role} ${role.perSecond}/s at ${role.p50Ms}ms`).join(", ")}` })
            }

            const open = new Map<string, string>()
            for (const trouble of seen.troubles) {
                if (trouble.opened) open.set(trouble.entity, trouble.detail ?? trouble.what ?? "")
                else open.delete(trouble.entity)
            }
            if (open.size) found.push({ sign: "troubles", detail: [...open].map(([entity, detail]) => `${entity}: ${detail}`).join("; ") })

            const end = seen.senses.lastMs
            const quiet = end === null ? [] : Object.entries(seen.senses.channels).flatMap(([channel, heard]) => {
                if (heard.count < LIMITS.quiet.heard) return []
                const gap = (heard.lastMs - heard.firstMs) / (heard.count - 1)
                const silent = end - heard.lastMs
                if (silent < Math.max(LIMITS.quiet.leastMs, gap * LIMITS.quiet.gaps)) return []
                const rate = Math.round(1000 / gap * 10) / 10
                return [`${channel} fell silent ${Math.round(silent / 1000)}s before the end, after ${heard.count} arrivals at ${rate}/s`]
            })
            if (quiet.length) found.push({ sign: "quiet", detail: quiet.join("; ") })

            return { found: found, checked: ["faults", "failing", "slow", "deadline", "late", "memory", "saturated", "inference", "troubles", "quiet"] }
        },
    }
}

export type SignsT = ReturnType<typeof Signs>

/** A length of time as a reader takes it in: milliseconds under a second, seconds to a tenth above. */
function span(ms: number): string {
    return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 100) / 10}s`
}
