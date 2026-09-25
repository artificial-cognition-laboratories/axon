import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { cpus, totalmem } from "node:os"
import type { MachineCapacity, VramSource } from "./types"
import { ask, pending } from "./ask"

/**
 * Hardware — what this box HAS.
 *
 * Totals, not usage. Read once at construction: cores and installed memory do
 * not move, and a GPU that appears mid-session is a driver event rare enough
 * that a daemon restart is the honest response.
 *
 * ── Unknown, error, and absent are three different answers ──────────────────
 *
 * There is no portable video-memory API. NVIDIA answers through nvidia-smi,
 * AMD through sysfs, Apple shares system memory with the GPU, and everything
 * else cannot be measured at all. So `vram` is null on a machine we cannot
 * read — and every consumer must treat that as "no known ceiling" rather than
 * "no memory", because the second refuses every local model on most machines
 * in existence.
 *
 * A reader that FAILED is reported separately from one that was never there.
 * `nvidia-smi` present and exiting non-zero means a driver/kernel mismatch,
 * which on a rolling distribution is an ordinary state after an update — and
 * reporting it as "this machine has no GPU" is wrong at exactly the moment the
 * user needs to be told to reboot.
 */
export function Hardware() {
    /*
     * Probed on FIRST USE, not at construction.
     *
     * Construction is wiring; this probe runs `nvidia-smi` in a subprocess.
     * Doing it eagerly meant merely BUILDING the handle paid for a GPU query —
     * and `Axond()` is constructed in-process by the TUI and by every CLI
     * command (cli.ts, usePlatform.ts), so `axon --version` spawned nvidia-smi
     * to answer a question about a string.
     *
     * It was also a hang. A synchronous spawn from inside a bun test worker
     * can wedge: the child exits, the parent never resumes, and the suite sits
     * for eleven minutes on a defunct `[nvidia-smi]` while the same binary
     * answers instantly on the host. Every `apps/tui` test that touches the CLI
     * constructs Axond(), so that landed on the release gate as an
     * irreproducible red — green once, hung on the next run, no code change
     * between them.
     *
     * Laziness fixes both at once and costs nothing: the value is still read at
     * most once and still stable for the daemon's lifetime, it is simply not
     * read by callers who never ask what this machine can do.
     */
    let probed: MachineCapacity | null = null
    /** The stable 'not known yet' answer, so repeated reads agree. */
    let provisional: MachineCapacity | null = null

    return {
        /**
         * This machine's capacity. Latched on the first SETTLED reading.
         *
         * `ask()` answers from a cache and refreshes in the background, so the
         * very first call on a box with an NVIDIA card reports "not answered
         * yet". Latching THAT would freeze "unknown GPU" for the life of the
         * process — the probe correct, the cached answer permanently wrong —
         * and on the daemon that means never enforcing a VRAM ceiling again,
         * which is the one job the machine domain exists to do.
         *
         * So an unsettled probe is re-asked next call (a map lookup), and
         * capacity makes exactly ONE transition: unknown → known. It never
         * moves again, and never moves the other way.
         *
         * The provisional is built ONCE and returned by identity, not rebuilt
         * per call. Two reads during the same unsettled window must not be able
         * to differ — a caller comparing them would see hardware "change".
         */
        current(): MachineCapacity {
            if (probed !== null) return probed

            const reading = probe()
            if (reading !== null) {
                probed = reading
                return probed
            }
            provisional ??= {
                cores: cpus().length,
                ram: totalmem(),
                vram: null,
                vramDetail: null,
                gpu: null,
                vramSource: "unknown" as VramSource,
            }
            return provisional
        },
    }
}

export type HardwareT = ReturnType<typeof Hardware>

/** A settled reading, or null while a vendor tool has yet to answer. */
function probe(): MachineCapacity | null {
    const base = { cores: cpus().length, ram: totalmem() }
    const none = { vram: null, vramDetail: null, gpu: null }

    const nvidia = nvidiaCapacity()
    // The card is here and the probe has not come back yet. Not an answer, and
    // must not be cached as one.
    if (nvidia.kind === "pending") return null
    if (nvidia.kind === "ok") {
        return { ...base, vram: nvidia.vram, vramSource: "nvidia", vramDetail: null, gpu: nvidia.name }
    }
    if (nvidia.kind === "error") {
        // The card is here and unreadable. Saying so is the whole point of
        // this branch — the alternative renders identically to having no GPU.
        return { ...base, ...none, vramSource: "error", vramDetail: nvidia.detail }
    }

    const amd = amdCapacity()
    if (amd !== null) {
        return { ...base, vram: amd.vram, vramSource: "amdgpu", vramDetail: null, gpu: amd.name }
    }

    const apple = appleVram()
    if (apple !== null) {
        return { ...base, vram: apple, vramSource: "apple", vramDetail: null, gpu: "Apple Silicon" }
    }

    return { ...base, ...none, vramSource: "unknown" as VramSource }
}

type NvidiaProbe =
    | { kind: "ok"; vram: number; name: string }
    | { kind: "absent" }
    /** The tool is present and has not answered yet — ask again, do not cache. */
    | { kind: "pending" }
    | { kind: "error"; detail: string }

/**
 * NVIDIA's total memory and model name.
 *
 * Presence of the tool is checked before running it, so "not an NVIDIA
 * machine" and "the driver is broken" are answered separately rather than
 * both arriving as a failed exec. The tool ships with the driver, so its
 * absence is a reliable signal that there is no NVIDIA GPU here.
 *
 * Multi-GPU machines report one line each and the FIRST is used rather than
 * the sum: a model loads onto one card, and a total across cards advertises
 * room no single load can use.
 */
function nvidiaCapacity(): NvidiaProbe {
    if (!Bun.which("nvidia-smi")) return { kind: "absent" }

    try {
        const probed = ask([
            "nvidia-smi",
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        if (pending(probed)) return { kind: "pending" }
        if (probed.exitCode !== 0) {
            return { kind: "error", detail: firstLine(probed.stderr.toString()) || `nvidia-smi exited ${probed.exitCode}` }
        }

        const first = probed.stdout.toString().trim().split("\n")[0]
        const [name, total] = (first ?? "").split(",").map(field => field.trim())
        const mib = Number.parseInt(total ?? "", 10)
        if (!name || !Number.isFinite(mib) || mib <= 0) {
            return { kind: "error", detail: "nvidia-smi returned no usable reading" }
        }

        return { kind: "ok", vram: mib * 1024 * 1024, name: name }
    } catch (cause) {
        // The tool exists and could not be run at all — a permissions problem
        // or a broken install. Still an error, never an absence.
        return { kind: "error", detail: cause instanceof Error ? cause.message : String(cause) }
    }
}

/** Where the DRM subsystem publishes per-card information. */
const DRM_ROOT = "/sys/class/drm"

/**
 * The first amdgpu card that publishes its video memory.
 *
 * Exported because `Probe` must read USED memory from the SAME card this read
 * the total from. Two independent scans could disagree on a multi-GPU box and
 * report a used figure against another card's capacity.
 */
export function amdCardDevice(): string | null {
    if (!existsSync(DRM_ROOT)) return null

    try {
        for (const name of readdirSync(DRM_ROOT)) {
            if (!/^card\d+$/.test(name)) continue
            const device = join(DRM_ROOT, name, "device")
            if (existsSync(join(device, "mem_info_vram_total"))) return device
        }
    } catch {
        return null
    }
    return null
}

/** Read one sysfs integer, or null when it is missing or unparseable. */
export function sysfsNumber(path: string): number | null {
    try {
        const value = Number.parseInt(readFileSync(path, "utf-8").trim(), 10)
        return Number.isFinite(value) ? value : null
    } catch {
        return null
    }
}

/**
 * AMD reports video memory in bytes through sysfs, no tool required.
 *
 * This is why it matters more than it looks: `Hardware` read NVIDIA and Apple
 * only, so every AMD machine fell through to "unmeasurable" — and on Linux
 * desktops that is a large share of them. An unmeasurable ceiling also sends
 * `admit()` down its fallback path, where our own accounting decides whether a
 * load fits.
 */
function amdCapacity(): { vram: number; name: string } | null {
    const device = amdCardDevice()
    if (device === null) return null

    const total = sysfsNumber(join(device, "mem_info_vram_total"))
    if (total === null || total <= 0) return null

    return { vram: total, name: amdName(device) }
}

/**
 * A readable name for the card, where the kernel offers one.
 *
 * `product_name` is populated on newer amdgpu builds and empty on older ones,
 * so the generic label is the fallback rather than a failure — a name is a
 * nicety and the memory figure is what anything depends on.
 */
function amdName(device: string): string {
    try {
        const product = readFileSync(join(device, "product_name"), "utf-8").trim()
        if (product !== "") return product
    } catch { /* older driver, no such attribute */ }
    return "AMD GPU"
}

function firstLine(text: string): string {
    return text.trim().split("\n")[0]?.trim() ?? ""
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
