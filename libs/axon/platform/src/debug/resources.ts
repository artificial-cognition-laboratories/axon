import type { PartSeries, Summary } from "./types"

/** Readings before this long into a session are start-up, and are left out of a growth rate. */
const WARMUP_MS = 60_000
/** A growth rate needs at least this many readings to mean anything. */
const LEAST = 5
/**
 * A rate said of "lately" needs readings spanning at least this long: a
 * collector's sawtooth is a hundred megabytes, and over half a minute it reads
 * as tens of megabytes a minute of growth (measured 2026-10-09: a 109s session
 * of a brain that levels off at 1.1GB read "still growing, 40MB a minute").
 */
const LATELY_MS = 120_000
const MB = 1024 * 1024
/** How many of the machine's busiest processes are given back. */
const BUSIEST = 8

/**
 * Resources — what the agent's processes used over a session: memory and
 * whether it is growing, CPU and GPU, and which threads the CPU went to —
 * and, beside them, how busy the whole machine was and with what.
 *
 * From the usage samples in the log, so it covers the whole session, not
 * the telemetry window.
 */
export function Resources() {
    return {
        /** Each part's memory, CPU and GPU, and each thread group's CPU, busiest first. `points` is how many readings of each series to give back. */
        of(summary: Summary, points: number) {
            const usage = summary.log.usage
            const first = usage.at[0] ?? null
            const last = usage.at[usage.at.length - 1] ?? null
            return {
                window: { fromMs: first, toMs: last, seconds: first !== null && last !== null ? Math.round((last - first) / 1000) : 0, samples: usage.at.length },
                machine: usage.machine ? {
                    cores: usage.machine.cores,
                    ramMb: Math.round(usage.machine.ramTotal / MB),
                    cpuPercent: series.level(usage.machine.cpu),
                    // Over every sample, so a process busy for a tenth of the session reads as a tenth.
                    busiest: Object.entries(usage.machine.busiest)
                        .map(([name, group]) => ({ process: name, processes: group.threads, meanCores: round(group.totalCores / usage.at.length, 2), maxCores: round(group.maxCores, 2) }))
                        .sort((a, b) => b.meanCores - a.meanCores)
                        .slice(0, BUSIEST),
                } : null,
                parts: Object.fromEntries(Object.entries(usage.parts).map(([name, part]) => [name, read.part(usage.at, part, points)])),
                threads: Object.entries(usage.threads)
                    .map(([name, group]) => ({ thread: name, threads: group.threads, meanCores: group.samples ? round(group.totalCores / group.samples, 2) : null, maxCores: round(group.maxCores, 2) }))
                    .sort((a, b) => (b.meanCores ?? 0) - (a.meanCores ?? 0)),
            }
        },
    }
}

export type ResourcesT = ReturnType<typeof Resources>

const read = {
    part(at: number[], part: PartSeries, points: number) {
        const ram = series.measured(at, part.ram)
        const vram = series.measured(at, part.vram)
        const settled = ram.filter(reading => reading.at - at[0]! >= WARMUP_MS)
        return {
            shared: part.shared,
            ramMb: ram.length ? {
                first: round(ram[0]!.value / MB, 1),
                last: round(ram[ram.length - 1]!.value / MB, 1),
                peak: round(Math.max(...ram.map(reading => reading.value)) / MB, 1),
                // After start-up: memory a process takes to boot is not memory it is leaking.
                perMinute: series.slope(settled, 60_000 / MB),
                // Over the later half alone: memory that rose and levelled off is not rising now. Null until that half is long enough to tell.
                perMinuteLately: series.lately(settled.slice(Math.floor(settled.length / 2)), 60_000 / MB),
                series: series.thin(ram, points).map(reading => round(reading.value / MB, 1)),
            } : null,
            cpuCores: series.level(part.cpu),
            gpuPercent: series.level(part.gpu),
            vramMb: vram.length ? { last: round(vram[vram.length - 1]!.value / MB, 1), peak: round(Math.max(...vram.map(reading => reading.value)) / MB, 1) } : null,
        }
    },
}

type Reading = { at: number; value: number }

const series = {
    /** The readings that were taken, each with when. */
    measured(at: number[], values: Array<number | null>): Reading[] {
        return values.flatMap((value, index) => (value === null ? [] : [{ at: at[index]!, value: value }]))
    },

    /** The mean and the most of the readings taken; null when none was. */
    level(values: Array<number | null>): { mean: number; max: number } | null {
        const taken = values.filter((value): value is number => value !== null)
        if (taken.length === 0) return null
        return { mean: round(taken.reduce((sum, value) => sum + value, 0) / taken.length, 2), max: round(Math.max(...taken), 2) }
    },

    /** How fast the readings rise, by a line fitted through them, times `scale` — null with too few to say. */
    slope(readings: Reading[], scale: number): number | null {
        if (readings.length < LEAST) return null
        const meanAt = readings.reduce((sum, reading) => sum + reading.at, 0) / readings.length
        const meanValue = readings.reduce((sum, reading) => sum + reading.value, 0) / readings.length
        let over = 0
        let under = 0
        for (const reading of readings) {
            over += (reading.at - meanAt) * (reading.value - meanValue)
            under += (reading.at - meanAt) ** 2
        }
        return under === 0 ? null : round(over / under * scale, 1)
    },

    /** The slope of readings spanning at least LATELY_MS — null over less: too short to tell growth from the collector's sawtooth. */
    lately(readings: Reading[], scale: number): number | null {
        if (readings.length === 0 || readings[readings.length - 1]!.at - readings[0]!.at < LATELY_MS) return null
        return series.slope(readings, scale)
    },

    /** At most `points` of the readings, evenly spaced, always with the first and the last. */
    thin(readings: Reading[], points: number): Reading[] {
        if (readings.length <= points || points < 2) return readings
        return Array.from({ length: points }, (_, index) => readings[Math.round(index * (readings.length - 1) / (points - 1))]!)
    },
}

function round(value: number, places: number): number {
    const unit = 10 ** places
    return Math.round(value * unit) / unit
}
