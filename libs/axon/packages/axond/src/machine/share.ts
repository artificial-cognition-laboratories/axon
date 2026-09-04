import { readFileSync, readdirSync } from "node:fs"
import { cpus } from "node:os"
import type { AxonShare } from "./types"

type ShareOpts = {
    /**
     * Process groups Axon owns, beyond this one.
     *
     * Only consulted by the /proc fallback. Agents are already tracked and
     * signalled by process GROUP — "an agent is a launcher plus the runtime it
     * spawned" — so the group is the unit of ownership everywhere in the
     * daemon, and this reuses it rather than inventing a second answer to
     * "which processes are ours".
     */
    groups: () => number[]
    /** Whether the expensive per-process GPU query is worth making this tick. */
    gpu?: () => boolean
}

/**
 * Share — what AXON costs this machine, as opposed to what the machine costs.
 *
 * The counterpart to `Probe`. Probe reads the whole box and is scrupulously
 * ignorant of who is using it; this reads only our own consumption, so a chart
 * can draw one inside the other and a person can see the difference between
 * "this machine is busy" and "Axon is making it busy".
 *
 * ── The cgroup does the accounting ──────────────────────────────────────────
 *
 * `axond.service` is a systemd unit, so every agent the daemon spawns inherits
 * its cgroup and the KERNEL totals them. That is two file reads per tick
 * against walking `/proc`, and it is exact: no double-counting of shared
 * pages, no race between enumerating processes and reading them, nothing
 * missed because it was spawned between two scans.
 *
 * It also makes the invariant structural rather than enforced. A cgroup's
 * usage is a subset of the machine's by construction, so our line can never
 * cross above the machine's — no clamping, no special case.
 *
 * ── Anonymous memory, not `memory.current` ──────────────────────────────────
 *
 * `memory.current` is everything the kernel charges us, page cache included.
 * Downloading a five-gigabyte weight charges those pages to this cgroup, so a
 * chart drawn from it would accuse Axon of holding five gigabytes of RAM that
 * is reclaimable the instant anything else wants it. `anon` is what we
 * genuinely occupy.
 *
 * ── Never throws, and null is not zero ──────────────────────────────────────
 *
 * Same contract as `Probe`: every field is nullable and every failure is a
 * null. A machine whose share cannot be attributed and a machine where Axon is
 * idle are different facts, and rendering the first as a flat line along the
 * floor would claim we measured something we did not.
 */
export function Share(opts: ShareOpts) {
    const cgroup = cgroupPath()
    const cores = cpus().length

    /**
     * The previous CPU reading, because utilisation is a RATE.
     *
     * One reading is microseconds since the cgroup was created and says
     * nothing about now, so the first call reports null rather than a number
     * computed against nothing. Exactly the shape `Probe` uses for the
     * machine's own CPU.
     */
    let previous: { usec: number; at: number } | null = null

    return {
        /** How the share is being measured. Diagnostics — a surface can say why a figure is coarse. */
        get source(): "cgroup" | "proc" {
            return cgroup !== null ? "cgroup" : "proc"
        },

        /** One reading. Synchronous and self-contained — safe to call from a timer. */
        read(): AxonShare {
            /*
             * Our pids, read once and shared by both consumers below.
             *
             * The cgroup already knows them — `cgroup.procs` IS the membership
             * list — so the `/proc` scan runs only on the fallback path. Doing
             * it per consumer would also mean two different pid sets inside
             * one reading, which is the drift this whole file exists to avoid.
             */
            const pids = cgroup !== null ? cgroupPids(cgroup) : ours(opts.groups())
            const memory = cgroup !== null ? cgroupAnon(cgroup) : procAnon(pids)
            const cpu = cgroup !== null ? cgroupCpu(cgroup) : procCpu(pids)

            let util: number | null = null
            if (cpu !== null) {
                const now = { usec: cpu, at: Date.now() }
                if (previous !== null && now.at > previous.at) {
                    const elapsed = (now.at - previous.at) * 1000
                    const used = now.usec - previous.usec
                    // Across all cores, 0-100 — the same units the machine's
                    // own cpuUtil uses, so the two series share one axis.
                    util = elapsed > 0 ? clamp((used / (elapsed * cores)) * 100) : null
                }
                previous = now
            }

            return {
                ram: memory,
                cpuUtil: util,
                vram: opts.gpu?.() === false ? null : nvidiaShare(pids),
                at: Date.now(),
            }
        },
    }
}

export type ShareT = ReturnType<typeof Share>

/**
 * This process's cgroup v2 directory, or null.
 *
 * `/proc/self/cgroup` on v2 is a single `0::<path>` line relative to the
 * mount. A v1 machine, a container without the mount, or a kernel with the
 * controllers disabled all end up here as null and fall through to `/proc`.
 */
function cgroupPath(): string | null {
    try {
        const line = readFileSync("/proc/self/cgroup", "utf-8")
            .split("\n")
            .find(entry => entry.startsWith("0::"))
        if (!line) return null

        const path = `/sys/fs/cgroup${line.slice(3).trim()}`
        // Accounting has to be ENABLED, not merely mounted: a cgroup without
        // the memory controller has the directory and not the file.
        readFileSync(`${path}/memory.stat`, "utf-8")
        return path
    } catch {
        return null
    }
}

/** Every pid in the cgroup. The kernel's own membership list — no scan needed. */
function cgroupPids(path: string): number[] {
    try {
        return readFileSync(`${path}/cgroup.procs`, "utf-8")
            .split("\n")
            .map(line => Number(line.trim()))
            .filter(pid => Number.isInteger(pid) && pid > 0)
    } catch {
        return []
    }
}

/** Anonymous bytes charged to the cgroup — see the note on `memory.current`. */
function cgroupAnon(path: string): number | null {
    try {
        const stat = readFileSync(`${path}/memory.stat`, "utf-8")
        const line = stat.split("\n").find(entry => entry.startsWith("anon "))
        if (!line) return null
        const bytes = Number(line.slice(5).trim())
        return Number.isFinite(bytes) ? bytes : null
    } catch {
        return null
    }
}

/** Cumulative CPU microseconds charged to the cgroup. A counter, not a rate. */
function cgroupCpu(path: string): number | null {
    try {
        const stat = readFileSync(`${path}/cpu.stat`, "utf-8")
        const line = stat.split("\n").find(entry => entry.startsWith("usage_usec "))
        if (!line) return null
        const usec = Number(line.slice(11).trim())
        return Number.isFinite(usec) ? usec : null
    } catch {
        return null
    }
}

/**
 * Every pid whose process group is one of ours.
 *
 * The fallback path, for a daemon started from a terminal rather than from its
 * unit — which is every development session. Costs a `/proc` scan, which is
 * why it is not the primary.
 */
function ours(groups: number[]): number[] {
    const wanted = new Set([...groups, processGroup(process.pid)].filter((id): id is number => id !== null))
    if (wanted.size === 0) return []

    try {
        const pids: number[] = []
        for (const entry of readdirNumeric("/proc")) {
            const group = processGroup(entry)
            if (group !== null && wanted.has(group)) pids.push(entry)
        }
        return pids
    } catch {
        return []
    }
}

/** Resident anonymous bytes across a pid set, from `/proc/<pid>/statm`. */
function procAnon(pids: number[]): number | null {
    if (pids.length === 0) return null
    const page = 4096
    let total = 0
    let read = 0
    for (const pid of pids) {
        try {
            // Fields are page counts: size, resident, shared, … Resident minus
            // shared approximates anonymous memory, which is the same figure
            // the cgroup path reports — a process's share of a mapped file is
            // not memory Axon is occupying.
            const parts = readFileSync(`/proc/${pid}/statm`, "utf-8").trim().split(/\s+/)
            const resident = Number(parts[1])
            const shared = Number(parts[2])
            if (!Number.isFinite(resident) || !Number.isFinite(shared)) continue
            total += Math.max(0, resident - shared) * page
            read++
        } catch {
            // The process exited between the scan and the read. Skipping it is
            // correct; it is no longer costing this machine anything.
        }
    }
    return read > 0 ? total : null
}

/** Cumulative CPU microseconds across a pid set, from `/proc/<pid>/stat`. */
function procCpu(pids: number[]): number | null {
    if (pids.length === 0) return null
    const tick = 100 // CONFIG_HZ, and there is no portable way to ask for it.
    let ticks = 0
    let read = 0
    for (const pid of pids) {
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8")
            // The comm field can contain spaces and parentheses, so fields are
            // counted from after the LAST ')' rather than by splitting the
            // whole line — a process named "(a b)" breaks the naive split.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
            const utime = Number(fields[11])
            const stime = Number(fields[12])
            if (!Number.isFinite(utime) || !Number.isFinite(stime)) continue
            ticks += utime + stime
            read++
        } catch {
            // Exited mid-scan. See procAnon.
        }
    }
    return read > 0 ? (ticks / tick) * 1_000_000 : null
}

/** A pid's process group, or null when it is gone or unreadable. */
function processGroup(pid: number): number | null {
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf-8")
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        const group = Number(fields[2])
        return Number.isFinite(group) ? group : null
    } catch {
        return null
    }
}

/** Numeric entries of /proc — the pids, without the kernel's other files. */
function readdirNumeric(path: string): number[] {
    return readdirSync(path)
        .map(name => Number(name))
        .filter(value => Number.isInteger(value) && value > 0)
}

/**
 * Video memory the driver has actually given our processes.
 *
 * Distinct from residency's `held`, which is a RESERVATION: admission control
 * needs to know what it has promised, and this reports what was delivered.
 * They will disagree — a weight is held before its runtime has finished
 * allocating, and a runtime's context costs memory no adapter declared. The
 * chart wants this one; admission must keep using the other.
 *
 * Absent nvidia-smi means no NVIDIA GPU, which is the same signal `Hardware`
 * reads it as. AMD exposes no per-process equivalent through sysfs, so those
 * machines report null rather than a wrong number.
 */
function nvidiaShare(pids: number[]): number | null {
    if (pids.length === 0) return null
    if (!Bun.which("nvidia-smi")) return null

    try {
        const probed = Bun.spawnSync([
            "nvidia-smi",
            "--query-compute-apps=pid,used_memory",
            "--format=csv,noheader,nounits",
        ])
        if (probed.exitCode !== 0) return null

        const mine = new Set(pids)
        let total = 0
        for (const line of new TextDecoder().decode(probed.stdout).trim().split("\n")) {
            if (line.trim() === "") continue
            const [pid, used] = line.split(",").map(part => Number(part.trim()))
            if (pid === undefined || used === undefined) continue
            if (!mine.has(pid)) continue
            // Reported in MiB.
            total += used * 1024 * 1024
        }
        // Zero is a real answer: the query succeeded and none of our processes
        // hold video memory. That is different from being unable to ask, which
        // returned null above.
        return total
    } catch {
        return null
    }
}

/** Utilisation is a percentage; a rounding artefact must not read as 103%. */
function clamp(value: number): number {
    return Math.max(0, Math.min(100, value))
}
