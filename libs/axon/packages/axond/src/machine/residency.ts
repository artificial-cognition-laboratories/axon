import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Hold } from "./types"

type ResidencyOpts = {
    /** Where THIS process writes. Reads always span every root. Tests point it at a scratch dir. */
    root?: string
}

/**
 * Where holds live.
 *
 * BOTH store roots are read and one is written — the same rule the running
 * registry follows, and for the same reason: an installed CLI and a source
 * build are different binaries describing the SAME machine, and an observer
 * that saw only its own would report a GPU as free while the other binary's
 * agent was using it.
 */
const ROOTS = [
    join(homedir(), ".axon", "cache", "resources"),
    join(homedir(), ".axon-dev", "cache", "resources"),
]

/**
 * Residency — what Axon holds on this machine, and who holds it.
 *
 * ── Why this survives the daemon ────────────────────────────────────────────
 *
 * One file per hold, read by everyone, rather than state inside the daemon.
 * That looks redundant now that a daemon exists — but the daemon being down
 * must not make local agents unable to work, and a file protocol every reader
 * can reap is the honest degraded path. The daemon becomes the AUTHORITATIVE
 * holder; the files stay the fallback.
 *
 * ── Dead holders are reaped where they are found ────────────────────────────
 *
 * Every reader already has to probe liveness to answer honestly, so cleaning
 * up while it looks costs nothing and means no reaper exists to fail. A
 * process killed with -9 releases its memory to the driver immediately; this
 * makes the record agree.
 */
export function Residency(opts: ResidencyOpts = {}) {
    const writeRoot = opts.root ?? ROOTS[1]!

    return {
        /**
         * Every live hold on this machine.
         *
         * Reaps as it reads — a record whose pid is gone is deleted rather
         * than filtered, so the directory does not accumulate the debris of
         * every crashed agent.
         */
        live(): Hold[] {
            const found: Hold[] = []

            for (const root of new Set([...ROOTS, writeRoot])) {
                if (!existsSync(root)) continue

                for (const name of readdirSync(root)) {
                    const path = join(root, name)
                    const record = read(path)

                    if (!record || !alive(record.pid)) {
                        // Best-effort: another process reaping the same record
                        // at the same moment is the ordinary case, not a fault.
                        try { rmSync(path, { force: true }) } catch { /* raced */ }
                        continue
                    }
                    found.push(record)
                }
            }

            return found
        },

        /**
         * Bytes held, counting each WEIGHT once however many agents hold it.
         *
         * Not a sum over holds. The models domain exists so that one resident
         * copy serves every agent that asked for it, so two agents sharing a
         * 6GB weight produce two holds against 6GB of real memory — and adding
         * them reports 12GB against a machine using 6.
         *
         * That is not cosmetic. `admit()` falls back to this figure whenever
         * the GPU cannot be probed, which is every machine `Hardware` cannot
         * read, and an inflated total refuses loads that would have fit.
         */
        held(): number {
            const seen = new Set<string>()
            let total = 0
            for (const hold of this.live()) {
                if (seen.has(hold.model)) continue
                seen.add(hold.model)
                total += hold.bytes
            }
            return total
        },

        /**
         * Record a hold. Returns its id, which `release` takes.
         *
         * Written AFTER the load succeeds, never before: a hold for a model
         * that failed to load would shrink the machine's apparent capacity for
         * as long as the process lived, and nothing would ever clear it.
         * Over-committing briefly while a load is in flight is the lesser
         * fault — it self-corrects, a phantom hold does not.
         */
        take(entry: Omit<Hold, "id" | "pid" | "at">): Hold {
            const hold: Hold = {
                ...entry,
                id: `${process.pid}-${entry.role}-${Bun.randomUUIDv7()}`,
                pid: process.pid,
                at: Date.now(),
            }
            mkdirSync(writeRoot, { recursive: true })
            writeFileSync(join(writeRoot, `${hold.id}.json`), JSON.stringify(hold), "utf-8")
            return hold
        },

        /** Release one hold. A no-op when already gone — unloading twice is not an error. */
        release(id: string): void {
            for (const root of new Set([...ROOTS, writeRoot])) {
                try { rmSync(join(root, `${id}.json`), { force: true }) } catch { /* raced */ }
            }
        },

        /** Release everything this process holds — the one place a clean exit matters. */
        releaseAll(): void {
            for (const hold of this.live()) {
                if (hold.pid === process.pid) this.release(hold.id)
            }
        },
    }
}

export type ResidencyT = ReturnType<typeof Residency>

/**
 * A record that fails to parse is treated as absent.
 *
 * A write torn mid-flush must not empty a reader's whole view, and the next
 * write supersedes it. Being wrong permissively risks over-committing memory
 * once; being wrong strictly breaks every reader on one bad file.
 */
function read(path: string): Hold | null {
    try {
        const record = JSON.parse(readFileSync(path, "utf-8")) as Hold
        return typeof record.pid === "number" && typeof record.bytes === "number" ? record : null
    } catch {
        return null
    }
}

/** True if a process with this pid exists — probes, sends nothing. */
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}
