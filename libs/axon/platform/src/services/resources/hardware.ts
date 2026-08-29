import { totalmem } from "node:os"

/**
 * What this machine can offer local inference.
 *
 * PROBED, never assumed, and honest about not knowing. There is no portable
 * API for video memory: NVIDIA answers through nvidia-smi, Apple silicon
 * shares system memory with the GPU, and AMD/Intel on Linux report through
 * sysfs paths that vary by driver. So `vram` is `undefined` on a machine we
 * cannot measure, and every consumer has to handle that rather than reading
 * a fabricated zero.
 *
 * UNKNOWN MEANS UNBOUNDED, never empty. A probe that failed and a card with
 * no free memory are opposite facts, and treating the first as the second
 * would refuse every local model on any machine we cannot read — which is
 * most of them. The user's declared budget is what governs where we cannot
 * measure.
 */

export type Hardware = {
    /** Total video memory in bytes. Undefined when unmeasurable — never zero. */
    vram?: number
    /** Total system memory in bytes. Always known. */
    ram: number
    /** How `vram` was learned, for a surface that wants to say so. */
    source: "nvidia" | "apple" | "unknown"
}

/** Bytes, from an nvidia-smi MiB figure. */
function fromMiB(text: string): number | null {
    const value = Number.parseInt(text.trim(), 10)
    return Number.isFinite(value) && value > 0 ? value * 1024 * 1024 : null
}

/**
 * NVIDIA's total video memory, through nvidia-smi.
 *
 * The tool ships with the driver, so its absence is the signal that there is
 * no NVIDIA GPU here — not an error worth reporting. Multi-GPU machines
 * report one line each; the FIRST is used rather than the sum, because a
 * model loads onto one card and a total across cards would advertise room no
 * single load can use.
 */
function nvidiaVram(): number | null {
    try {
        const probe = Bun.spawnSync([
            "nvidia-smi",
            "--query-gpu=memory.total",
            "--format=csv,noheader,nounits",
        ])
        if (probe.exitCode !== 0) return null

        const first = probe.stdout.toString().trim().split("\n")[0]
        return first ? fromMiB(first) : null
    } catch {
        return null
    }
}

/**
 * Apple silicon shares one pool between CPU and GPU.
 *
 * So "video memory" is a fraction of system memory rather than a separate
 * number — macOS lets the GPU address most of it but not all, and the exact
 * ceiling is a driver detail that moves. Two thirds is deliberately
 * conservative: over-reporting here means accepting a load that then thrashes
 * the whole machine, which is worse than refusing one that would have fit.
 */
function appleVram(): number | null {
    if (process.platform !== "darwin") return null
    return Math.floor(totalmem() * (2 / 3))
}

/**
 * Read this machine once.
 *
 * Synchronous and cheap enough to call per boot: one subprocess on NVIDIA,
 * arithmetic everywhere else. Not cached here — a caller that wants it cached
 * holds it, and a long-running process re-reading after a driver change is a
 * feature rather than a cost.
 */
export function probeHardware(): Hardware {
    const nvidia = nvidiaVram()
    if (nvidia !== null) return { vram: nvidia, ram: totalmem(), source: "nvidia" }

    const apple = appleVram()
    if (apple !== null) return { vram: apple, ram: totalmem(), source: "apple" }

    return { ram: totalmem(), source: "unknown" }
}

const UNITS: Record<string, number> = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
}

/**
 * `"8GB"` → bytes.
 *
 * Null for anything unparseable, which callers treat as "no ceiling declared"
 * rather than as zero — see ResourceBudget. Accepts a bare number as bytes so
 * a programmatic caller need not format a string it is about to have parsed.
 */
export function parseSize(value: string | number | undefined): number | null {
    if (value === undefined) return null
    if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null

    const match = value.trim().toLowerCase().match(/^([\d.]+)\s*(b|kb|mb|gb|tb)?$/)
    if (!match?.[1]) return null

    const size = Number.parseFloat(match[1])
    if (!Number.isFinite(size) || size <= 0) return null

    return Math.floor(size * (UNITS[match[2] ?? "b"] ?? 1))
}

/** Bytes → `"7.4GB"`, for a surface that shows a person a number. */
export function formatSize(bytes: number): string {
    if (bytes >= UNITS.gb!) return `${(bytes / UNITS.gb!).toFixed(1)}GB`
    if (bytes >= UNITS.mb!) return `${Math.round(bytes / UNITS.mb!)}MB`
    return `${bytes}B`
}
