import { existsSync, readFileSync } from "node:fs"

/**
 * cpu — utilisation and clock speed, per core.
 *
 * Load is a RATE, derived from two reads of a monotonic counter, so the
 * same reasoning applies here as to network throughput: the body
 * differentiates, because that is what the instrument measures. A raw jiffy
 * count is unplottable and unchanging in the only way a lane can show,
 * while "how busy is this core" is the quantity that actually varies.
 *
 * Per core rather than aggregated. One number hides the thing worth seeing:
 * a single-threaded process pinning one core reads as 12% overall, which
 * looks idle. Eight components sampled at one instant show it immediately —
 * and they are comparable precisely because they were read together.
 */

export type CpuSample = { idle: number; total: number }

/** Per-core cumulative jiffies, from /proc/stat. Index 0 is cpu0. */
function readStat(): CpuSample[] {
    const samples: CpuSample[] = []
    for (const line of readFileSync("/proc/stat", "utf-8").split("\n")) {
        // "cpu0 149242 285 50577 1412425 1608 0 71 0 0 0" — the aggregate
        // "cpu" line is skipped: it is the sum of the per-core lines, so
        // reporting it as a ninth component would be one number derived
        // from the other eight rather than a measurement of anything.
        if (!/^cpu\d+ /.test(line)) continue
        const fields = line.split(/\s+/).slice(1).map(Number)
        const idle = (fields[3] ?? 0) + (fields[4] ?? 0) // idle + iowait
        const total = fields.reduce((sum, value) => sum + value, 0)
        samples.push({ idle, total })
    }
    return samples
}

export type CpuT = {
    readonly cores: number
    /** Per-core busy percentage since the last call, or null on the first. */
    load(): number[] | null
    /** Per-core current clock in MHz, or null where the kernel exposes none. */
    freq(): number[] | null
}

export function Cpu(): CpuT {
    let previous: CpuSample[] | null = null
    const cores = readStat().length

    return {
        cores,

        load() {
            const current = readStat()
            const last = previous
            previous = current

            // A rate needs two samples. Emitting zero from one would be a
            // measurement nobody took.
            if (!last || last.length !== current.length) return null

            return current.map((sample, i) => {
                const idle = sample.idle - last[i]!.idle
                const total = sample.total - last[i]!.total
                if (total <= 0) return 0
                return Math.round((1 - idle / total) * 1000) / 10
            })
        },

        freq() {
            const values: number[] = []
            for (let i = 0; i < cores; i++) {
                const path = `/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`
                if (!existsSync(path)) return null // no governor exposed at all
                const raw = readFileSync(path, "utf-8").trim()
                // kHz on disk; MHz is what a human reads a clock in.
                values.push(Math.round(Number(raw) / 1000))
            }
            return values
        },
    }
}
