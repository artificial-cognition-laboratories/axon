import { readFileSync } from "node:fs"

/**
 * memory — RAM and swap, and this process's own footprint.
 *
 * The self reading is the interesting one. An agent that can feel how much
 * memory IT is using has a sense no other sensor here provides: the others
 * describe the machine it happens to run on, this one describes the body it
 * actually is. A mind that watches its own footprint climb has the raw
 * material to notice it is leaking — which is the machine equivalent of
 * feeling unwell, and exactly the kind of thing proprioception is for.
 *
 * MiB throughout rather than kB: the kernel reports kB, and a number in the
 * tens of millions is harder to read at a glance than one in the thousands.
 */

function meminfo(): Record<string, number> {
    const values: Record<string, number> = {}
    for (const line of readFileSync("/proc/meminfo", "utf-8").split("\n")) {
        const match = /^(\w+):\s+(\d+) kB/.exec(line)
        if (match) values[match[1]!] = Number(match[2])
    }
    return values
}

const toMiB = (kb: number): number => Math.round(kb / 1024)

export type MemoryReading = {
    /** [used, available, total] in MiB. */
    ram: number[]
    /** [used, total] in MiB, or null when the machine has no swap configured. */
    swap: number[] | null
    /** [rss, threads] — this agent process's own footprint. */
    self: number[]
}

export function readMemory(): MemoryReading {
    const info = meminfo()

    const total = info.MemTotal ?? 0
    // MemAvailable, not MemFree: free excludes cache the kernel would
    // reclaim under pressure, so it reads alarmingly low on a healthy
    // machine. Available is the number that means "could be allocated".
    const available = info.MemAvailable ?? 0

    const swapTotal = info.SwapTotal ?? 0
    const swapFree = info.SwapFree ?? 0

    const status = readFileSync("/proc/self/status", "utf-8")
    const rss = Number(/^VmRSS:\s+(\d+) kB/m.exec(status)?.[1] ?? 0)
    const threads = Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 0)

    return {
        ram: [toMiB(total - available), toMiB(available), toMiB(total)],
        swap: swapTotal > 0 ? [toMiB(swapTotal - swapFree), toMiB(swapTotal)] : null,
        self: [toMiB(rss), threads],
    }
}
