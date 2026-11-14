import { readdirSync, readFileSync } from "node:fs"
import type { UsagePart, UsageProcess, UsageThread } from "@arcforge/types"
import type { AttributionT } from "./attribution"

/** Kernel clock ticks per second — the unit /proc reports CPU time in. 100 on every Linux Axon runs on. */
const TICKS = 100
/** Bytes per page, for /proc/<pid>/statm. */
const PAGE = 4096
/** Threads reported per call — the busiest; past this they are idle helpers. */
const THREADS_MOST = 64
/** A process busier than this many cores is worth naming among the machine's busiest. */
const BUSY_LEAST = 0.05

/**
 * Accounting — what named groups of processes cost, measured.
 *
 * `Share` answers "what does Axon cost this machine" from the daemon's
 * cgroup. This answers the finer question a person watching one agent
 * asks: of that, how much is its brain, its body, the models it uses. A
 * part is a set of ROOT processes and everything they started — the tree,
 * found by parent pid. Not process groups: a confined agent runs through
 * `systemd-run → bwrap → launcher → runtime` and shares the daemon's group,
 * while its tree is exactly its own.
 *
 * CPU is a rate, so a part's first reading is null: there is nothing to
 * difference against. GPU is each process's average since this reader's
 * previous measure, from the machine's shared `Attribution` stream. Without
 * an NVIDIA driver the GPU figures are null: unmeasured, not idle.
 *
 * `threads` is the same CPU accounting one level down: every thread of the
 * given processes, by name and id, from /proc/<pid>/task. That is how a
 * worker pool's imbalance — one thread pegged, three idle — becomes visible.
 *
 * `busiest` is the other direction: every process on the machine, whoever's
 * it is. A machine at its limit with the agent's parts adding up to a
 * quarter of it is somebody else's machine at that moment, and this names
 * who.
 */
export function Accounting(opts: { attribution: AttributionT }) {
    /** CPU time last seen per pid, for turning totals into rates. */
    let previous = new Map<number, { ticks: number; at: number }>()
    /** CPU time last seen per thread id, likewise. */
    let previousThreads = new Map<number, { ticks: number; at: number }>()
    /** CPU time last seen for every process on the machine, for `busiest`. */
    let previousAll = new Map<number, { ticks: number; at: number }>()
    /** When GPU was last read — the start of the next reading's window. */
    let gpuSince = Date.now() - 2_000

    return {
        /** Every pid in the trees under `roots` right now — who counts as "this agent" when matching it to what it holds elsewhere. */
        family(roots: number[]): Set<number> {
            return tree(scan(), roots)
        },

        /**
         * Measure each part — its root processes and their descendants — now.
         * `shared` is carried through: a part other agents also use is
         * labelled, not divided.
         */
        measure(parts: Record<string, { roots: number[]; shared: boolean; alone?: boolean }>): Record<string, UsagePart> {
            const now = Date.now()
            const processes = scan()
            const gpu = opts.attribution.since(gpuSince)
            gpuSince = now
            const seen = new Map<number, { ticks: number; at: number }>()
            const out: Record<string, UsagePart> = {}

            for (const [name, part] of Object.entries(parts)) {
                // `alone`: the roots themselves, for a process whose children are other parts — the daemon.
                const members = part.alone ? new Set(part.roots) : tree(processes, part.roots)
                let cpu: number | null = 0
                let ram = 0
                let busy: number | null = gpu ? 0 : null
                let vram: number | null = gpu ? 0 : null
                let count = 0
                for (const process of processes) {
                    if (!members.has(process.pid)) continue
                    count++
                    ram += process.rss
                    seen.set(process.pid, { ticks: process.ticks, at: now })
                    const before = previous.get(process.pid)
                    // A process with no earlier reading has no rate yet; the part's CPU is unknown until it does.
                    if (!before) cpu = null
                    else if (cpu !== null) cpu += (process.ticks - before.ticks) / TICKS / ((now - before.at) / 1000)
                    const card = gpu?.get(process.pid)
                    if (card && busy !== null && vram !== null) {
                        busy += card.busy
                        vram += card.memory
                    }
                }
                out[name] = {
                    cpu: count > 0 && cpu !== null ? Math.round(cpu * 100) / 100 : count > 0 ? null : 0,
                    ram: ram,
                    gpu: busy === null ? null : Math.round(busy * 10) / 10,
                    vram: vram,
                    processes: count,
                    shared: part.shared,
                }
            }
            previous = seen
            return out
        },

        /** The `most` busiest processes on the machine since the last call, busiest first. Empty on the first call: a rate needs two readings. */
        busiest(most: number): UsageProcess[] {
            const now = Date.now()
            const seen = new Map<number, { ticks: number; at: number }>()
            const out: UsageProcess[] = []
            for (const process of scan()) {
                seen.set(process.pid, { ticks: process.ticks, at: now })
                const before = previousAll.get(process.pid)
                if (!before || now <= before.at) continue
                const cpu = (process.ticks - before.ticks) / TICKS / ((now - before.at) / 1000)
                if (cpu >= BUSY_LEAST) out.push({ pid: process.pid, name: process.name, cpu: Math.round(cpu * 100) / 100 })
            }
            previousAll = seen
            return out.sort((a, b) => b.cpu - a.cpu).slice(0, most)
        },

        /**
         * Every thread of these processes and their descendants: id, name,
         * and cores busy since the last call (null on a thread's first).
         * Capped per process — a runtime has a few dozen; anything past the
         * cap is idle helpers, sorted last.
         */
        threads(roots: number[]): UsageThread[] {
            const now = Date.now()
            const members = tree(scan(), roots)
            const seen = new Map<number, { ticks: number; at: number }>()
            const out: UsageThread[] = []
            for (const pid of members) {
                for (const thread of tasks(pid)) {
                    seen.set(thread.tid, { ticks: thread.ticks, at: now })
                    const before = previousThreads.get(thread.tid)
                    const cpu = before ? (thread.ticks - before.ticks) / TICKS / ((now - before.at) / 1000) : null
                    out.push({ pid: pid, tid: thread.tid, name: thread.name, cpu: cpu === null ? null : Math.round(cpu * 100) / 100 })
                }
            }
            previousThreads = seen
            return out.sort((a, b) => (b.cpu ?? 0) - (a.cpu ?? 0)).slice(0, THREADS_MOST)
        },
    }
}

export type AccountingT = ReturnType<typeof Accounting>

type Process = { pid: number; name: string; parent: number; ticks: number; rss: number }

/** The roots and every process descended from them. */
function tree(processes: Process[], roots: number[]): Set<number> {
    const children = new Map<number, number[]>()
    for (const process of processes) children.set(process.parent, [...(children.get(process.parent) ?? []), process.pid])
    const members = new Set<number>()
    const queue = [...roots]
    while (queue.length) {
        const pid = queue.pop()!
        if (members.has(pid)) continue
        members.add(pid)
        queue.push(...(children.get(pid) ?? []))
    }
    return members
}

/**
 * Every process's name, parent, CPU time and resident memory, from /proc. A
 * process that exits mid-scan is skipped — it is gone, which is its answer.
 */
function scan(): Process[] {
    const out: Process[] = []
    for (const name of readdirSync("/proc")) {
        const pid = Number(name)
        if (!Number.isInteger(pid)) continue
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf-8")
            // The command name is in parentheses and may contain spaces; fields resume after the last ')'.
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
            const parent = Number(fields[1])
            const ticks = Number(fields[11]) + Number(fields[12])
            const rss = Number(readFileSync(`/proc/${pid}/statm`, "utf-8").split(" ")[1]) * PAGE
            out.push({ pid: pid, name: stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")")), parent: parent, ticks: ticks, rss: rss })
        } catch {
            // Exited between readdir and read.
        }
    }
    return out
}

/** One process's threads: id, the name the runtime gave it, and its CPU time. A thread gone mid-read is skipped. */
function tasks(pid: number): Array<{ tid: number; name: string; ticks: number }> {
    const out: Array<{ tid: number; name: string; ticks: number }> = []
    let names: string[]
    try {
        names = readdirSync(`/proc/${pid}/task`)
    } catch {
        // The process exited between the scan and this read.
        return out
    }
    for (const name of names) {
        const tid = Number(name)
        if (!Number.isInteger(tid)) continue
        try {
            const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, "utf-8")
            const open = stat.indexOf("(")
            const close = stat.lastIndexOf(")")
            const fields = stat.slice(close + 2).split(" ")
            out.push({ tid: tid, name: stat.slice(open + 1, close), ticks: Number(fields[11]) + Number(fields[12]) })
        } catch {
            // Exited between readdir and read.
        }
    }
    return out
}
