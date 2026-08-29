import { cpus, totalmem } from "node:os"
import type { MachineCapacity, VramSource } from "./types"

/**
 * Hardware — what this box HAS.
 *
 * Totals, not usage. Read once at construction: cores and installed memory do
 * not move, and a GPU that appears mid-session is a driver event rare enough
 * that a daemon restart is the honest response.
 *
 * ── Unknown means unbounded, never empty ────────────────────────────────────
 *
 * There is no portable video-memory API. NVIDIA answers through nvidia-smi,
 * Apple shares system memory with the GPU, and AMD/Intel on Linux report
 * through sysfs paths that vary by driver. So `vram` is null on a machine we
 * cannot measure — and every consumer must treat that as "no known ceiling"
 * rather than "no memory", because the second refuses every local model on
 * most machines in existence.
 */
export function Hardware() {
    const probed = probe()

    return {
        /** This machine's capacity. Stable for the daemon's lifetime. */
        current(): MachineCapacity {
            return probed
        },
    }
}

export type HardwareT = ReturnType<typeof Hardware>

function probe(): MachineCapacity {
    const base = { cores: cpus().length, ram: totalmem() }

    const nvidia = nvidiaCapacity()
    if (nvidia !== null) {
        return { ...base, vram: nvidia.vram, vramSource: "nvidia", gpu: nvidia.name }
    }

    const apple = appleVram()
    if (apple !== null) {
        return { ...base, vram: apple, vramSource: "apple", gpu: "Apple Silicon" }
    }

    return { ...base, vram: null, vramSource: "unknown" as VramSource, gpu: null }
}

/**
 * NVIDIA's total memory and model name.
 *
 * The tool ships with the driver, so its absence is the signal that there is
 * no NVIDIA GPU here — not an error worth reporting.
 *
 * Multi-GPU machines report one line each and the FIRST is used rather than
 * the sum: a model loads onto one card, and a total across cards advertises
 * room no single load can use.
 */
function nvidiaCapacity(): { vram: number; name: string } | null {
    try {
        const probed = Bun.spawnSync([
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        if (probed.exitCode !== 0) return null

        const first = probed.stdout.toString().trim().split("\n")[0]
        const [name, total] = (first ?? "").split(",").map(field => field.trim())
        const mib = Number.parseInt(total ?? "", 10)
        if (!name || !Number.isFinite(mib) || mib <= 0) return null

        return { vram: mib * 1024 * 1024, name: name }
    } catch {
        return null
    }
}

/**
 * Apple silicon shares one pool between CPU and GPU.
 *
 * Two thirds is deliberately conservative: macOS lets the GPU address most of
 * system memory but not all, and the exact ceiling is a driver detail that
 * moves. Over-reporting means accepting a load that then thrashes the whole
 * machine, which is worse than refusing one that would have fit.
 */
function appleVram(): number | null {
    if (process.platform !== "darwin") return null
    return Math.floor(totalmem() * (2 / 3))
}
