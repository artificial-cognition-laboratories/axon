import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * What one agent is holding on this machine.
 *
 * MACHINE-WIDE, not per-process: two agents on one laptop share a GPU, and
 * each keeping its own idea of free memory is precisely how both decide they
 * have room for the same six gigabytes. So the state is on disk, one file per
 * reservation, and every process reads the whole directory before deciding.
 *
 * Keyed by machine rather than by profile for the same reason. A budget is a
 * fact about hardware; two profiles on one laptop are two accounts, not two
 * GPUs.
 */
export type Reservation = {
    /** The holder — probed for liveness, so a dead one is self-clearing. */
    pid: number
    /** Which agent, for a surface that lists what is loaded. */
    agent: string
    /** The cognet role this serves — "asr", "vad". */
    role: string
    /** Model id, e.g. "onnx-community/whisper-base.en". */
    model: string
    /** Bytes held. */
    bytes: number
    /** When it was taken, unix ms. */
    at: number
}

/**
 * Where reservations live.
 *
 * Both store roots are READ, one is written — the same rule running/ follows
 * and for the same reason: an installed CLI and a source build are different
 * binaries describing the SAME machine, and an observer that saw only its own
 * would report a GPU as free while the other binary's agent was using it.
 */
const ROOTS = [
    join(homedir(), ".axon", "cache", "resources"),
    join(homedir(), ".axon-dev", "cache", "resources"),
]

/** True if a process with this pid exists — probes, sends nothing. */
function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch {
        return false
    }
}

/**
 * A record that fails to parse is treated as absent.
 *
 * Same posture as running/: a write torn mid-flush must not empty a reader's
 * whole view, and the next write supersedes it. Being wrong here in the
 * permissive direction risks over-committing memory once; being wrong in the
 * strict direction breaks every reader on one bad file.
 */
function read(path: string): Reservation | null {
    try {
        const record = JSON.parse(readFileSync(path, "utf-8")) as Reservation
        return typeof record.pid === "number" && typeof record.bytes === "number" ? record : null
    } catch {
        return null
    }
}

export type ReservationsOpts = {
    /** Where this process WRITES. Reads always span every root. */
    root?: string
}

export function Reservations(opts: ReservationsOpts = {}) {
    const writeRoot = opts.root ?? ROOTS[1]!

    function ensure(): string {
        mkdirSync(writeRoot, { recursive: true })
        return writeRoot
    }

    /**
     * Every live reservation on this machine.
     *
     * Dead holders are REAPED as they are found rather than by a background
     * sweep: every reader already has to probe liveness to answer honestly,
     * so cleaning up while it looks costs nothing and means no reaper exists
     * to fail. A process killed with -9 releases its memory to the driver
     * immediately; this makes the record agree.
     */
    function live(): Reservation[] {
        const found: Reservation[] = []

        for (const root of new Set([...ROOTS, writeRoot])) {
            if (!existsSync(root)) continue

            for (const name of readdirSync(root)) {
                const path = join(root, name)
                const record = read(path)

                if (!record || !isAlive(record.pid)) {
                    // Best-effort: another process reaping the same record at
                    // the same moment is the ordinary case, not a fault.
                    try { rmSync(path, { force: true }) } catch { /* raced */ }
                    continue
                }
                found.push(record)
            }
        }

        return found
    }

    return {
        live,

        /** Bytes currently held across every live holder. */
        held(): number {
            return live().reduce((total, entry) => total + entry.bytes, 0)
        },

        /**
         * Record a hold.
         *
         * Written AFTER the load succeeds, never before: a reservation for a
         * model that failed to load would shrink the machine's apparent
         * capacity for as long as the process lived, and nothing would ever
         * clear it. Over-committing briefly while a load is in flight is the
         * lesser fault — it self-corrects, a phantom hold does not.
         */
        take(entry: Omit<Reservation, "pid" | "at">): string {
            const record: Reservation = { ...entry, pid: process.pid, at: Date.now() }
            const path = join(ensure(), `${process.pid}-${entry.role}-${Bun.randomUUIDv7()}.json`)
            writeFileSync(path, JSON.stringify(record), "utf-8")
            return path
        },

        /** Release one hold. A no-op when already gone — unloading twice is not an error. */
        release(path: string): void {
            try { rmSync(path, { force: true }) } catch { /* already gone */ }
        },

        /** Release everything this process holds — shutdown, and the one place a clean exit matters. */
        releaseAll(): void {
            for (const root of new Set([...ROOTS, writeRoot])) {
                if (!existsSync(root)) continue
                for (const name of readdirSync(root)) {
                    const path = join(root, name)
                    const record = read(path)
                    if (record?.pid === process.pid) {
                        try { rmSync(path, { force: true }) } catch { /* raced */ }
                    }
                }
            }
        },
    }
}

export type ReservationsT = ReturnType<typeof Reservations>
