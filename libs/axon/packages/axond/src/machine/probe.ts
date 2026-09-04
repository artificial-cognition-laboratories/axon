import { readFileSync } from "node:fs"
import { join } from "node:path"
import { freemem, loadavg, totalmem } from "node:os"
import { amdCardDevice, sysfsNumber } from "./hardware"
import type { MachineReading } from "./types"

/**
 * Probe — what is in use RIGHT NOW.
 *
 * The reading that only a daemon can afford. `nvidia-smi` costs ~25ms, which
 * is nothing on a timer and far too much on the path of a request — so this is
 * polled by `Samples` and read from memory by everyone else.
 *
 * ── Never throws ────────────────────────────────────────────────────────────
 *
 * Every field is nullable and every failure is a null. A probe that threw
 * would take down the poll loop, and a resource manager that stops reading
 * because one GPU query failed is worse than one reporting "unknown" for that
 * field — the caller already has to handle unknown, since most machines
 * cannot be measured at all.
 *
 * It reads the WHOLE machine, not Axon's share. A browser holding 3GB of video
 * memory is real, and an admission check blind to it hands out memory that is
 * already gone. Our share is stamped on by `Samples`, which is the only thing
 * here that knows about residency.
 *
 * ── Utilisation is a rate, so this holds state ──────────────────────────────
 *
 * CPU percentage is the difference between two `/proc/stat` readings; a single
 * one describes the machine since boot and says nothing about now. So the
 * probe keeps the previous snapshot and the first reading reports null rather
 * than a number computed against nothing.
 */
export function Probe() {
    let previousCpu: CpuSnapshot | null = null

    return {
        /** One reading. Synchronous and self-contained — safe to call from a timer. */
        read(): MachineReading {
            const gpu = gpuUsage()
            const cpu = cpuSnapshot()
            const util = cpu !== null && previousCpu !== null ? cpuUtilisation(previousCpu, cpu) : null
            if (cpu !== null) previousCpu = cpu

            return {
                vramUsed: gpu?.used ?? null,
                gpuUtil: gpu?.util ?? null,
                cpuUtil: util,
                ramAvailable: availableMemory(),
                load: loadavg()[0] ?? 0,
                at: Date.now(),
            }
        },
    }
}

export type ProbeT = ReturnType<typeof Probe>

/**
 * Video memory in use and compute utilisation, whichever vendor can answer.
 *
 * NVIDIA first because its tool answers both figures in one call; AMD second
 * through sysfs, which costs two file reads and no subprocess at all. A
 * machine with neither reports null and the caller renders "unreadable".
 */
function gpuUsage(): { used: number; util: number | null } | null {
    return nvidiaUsage() ?? amdUsage()
}

function nvidiaUsage(): { used: number; util: number } | null {
    if (!Bun.which("nvidia-smi")) return null

    try {
        const probed = Bun.spawnSync([
            "nvidia-smi",
            "--query-gpu=memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        ])
        if (probed.exitCode !== 0) return null

        const first = probed.stdout.toString().trim().split("\n")[0]
        const [used, util] = (first ?? "").split(",").map(field => Number.parseInt(field.trim(), 10))
        if (!Number.isFinite(used) || !Number.isFinite(util)) return null

        return { used: used! * 1024 * 1024, util: util! }
    } catch {
        return null
    }
}

/**
 * AMD through sysfs — no tool, no subprocess.
 *
 * `gpu_busy_percent` is not published by every driver version, so utilisation
 * is nullable independently of memory: a card can report how full it is
 * without reporting how busy it is, and refusing both because one is missing
 * would throw away the figure admission actually needs.
 */
function amdUsage(): { used: number; util: number | null } | null {
    const device = amdCardDevice()
    if (device === null) return null

    const used = sysfsNumber(join(device, "mem_info_vram_used"))
    if (used === null) return null

    return { used: used, util: sysfsNumber(join(device, "gpu_busy_percent")) }
}

/** Cumulative jiffies since boot: everything, and the part that was idle. */
type CpuSnapshot = { total: number; idle: number }

/**
 * The aggregate `cpu` line of `/proc/stat`.
 *
 * Idle counts both `idle` and `iowait`: a core waiting on a disk is not doing
 * work, and counting iowait as busy makes a machine copying a model file look
 * pinned when it is asleep.
 */
function cpuSnapshot(): CpuSnapshot | null {
    try {
        const line = readFileSync("/proc/stat", "utf-8").split("\n")[0]
        if (!line || !line.startsWith("cpu ")) return null

        const fields = line.slice(4).trim().split(/\s+/).map(Number)
        if (fields.length < 5 || fields.some(value => !Number.isFinite(value))) return null

        const total = fields.reduce((sum, value) => sum + value, 0)
        const idle = (fields[3] ?? 0) + (fields[4] ?? 0)
        return { total: total, idle: idle }
    } catch {
        // Not Linux, or /proc is not mounted. Utilisation stays null, which the
        // caller already renders as "not measured" rather than as zero.
        return null
    }
}

/** Busy share between two snapshots, 0-100. */
function cpuUtilisation(previous: CpuSnapshot, current: CpuSnapshot): number | null {
    const total = current.total - previous.total
    const idle = current.idle - previous.idle
    // A tick with no elapsed jiffies divides by zero; a counter that went
    // backwards means the file was re-read across a boundary we cannot reason
    // about. Both are "no answer this time", not zero percent.
    if (total <= 0 || idle < 0) return null

    return Math.max(0, Math.min(100, ((total - idle) / total) * 100))
}

/**
 * Memory a new allocation can actually expect.
 *
 * `MemAvailable` where the kernel reports it, because FREE memory excludes
 * reclaimable page cache — a warm Linux box shows almost no free memory and is
 * not short of any. Falling back to `freemem()` elsewhere is the best portable
 * answer, and it errs conservative.
 */
function availableMemory(): number {
    try {
        const meminfo = readFileSync("/proc/meminfo", "utf-8")
        const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB$/m)
        if (match?.[1]) return Number.parseInt(match[1], 10) * 1024
    } catch {
        // Not Linux, or /proc is not mounted. freemem() is the portable answer.
    }
    return freemem() || totalmem()
}
