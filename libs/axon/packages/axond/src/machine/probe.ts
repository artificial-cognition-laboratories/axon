import { readFileSync } from "node:fs"
import { freemem, loadavg, totalmem } from "node:os"
import type { MachineUsage } from "./types"

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
 * already gone.
 */
export function Probe() {
    return {
        /** One reading. Synchronous and self-contained — safe to call from a timer. */
        read(): MachineUsage {
            const gpu = nvidiaUsage()
            return {
                vramUsed: gpu?.used ?? null,
                gpuUtil: gpu?.util ?? null,
                ramAvailable: availableMemory(),
                load: loadavg()[0] ?? 0,
                at: Date.now(),
            }
        },
    }
}

export type ProbeT = ReturnType<typeof Probe>

/** Video memory in use and compute utilisation, or null where unreadable. */
function nvidiaUsage(): { used: number; util: number } | null {
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
