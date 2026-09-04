import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { JobEvent } from "./types"

type LogOpts = {
    /** Where job logs are written. One file per job. */
    root: string
}

/**
 * Log — the append-only event stream behind every job.
 *
 * ── Why append-only, on one machine ─────────────────────────────────────────
 *
 * Because it will not be one machine. A job created here and worked on
 * elsewhere has several writers, and appending is the only shape where
 * concurrent writes cannot lose each other: two appends are an ordering
 * question, two updates to a status field are data loss. Locally there is one
 * writer and this costs nothing, which is exactly when to pay for it.
 *
 * It is also what `attach` will subscribe to, and what the panel renders. One
 * primitive, three uses.
 *
 * ── JSONL, and why a partial line is skipped rather than fatal ──────────────
 *
 * One event per line, appended with a single `appendFileSync` — which on a
 * local filesystem is atomic for writes under the pipe buffer, so a torn line
 * needs a crash mid-write to happen at all. If one does happen, the events
 * before it are still true and still the user's work. Discarding the whole job
 * because its last line was cut in half would destroy far more than it
 * protects, so a malformed line is dropped and the rest is read.
 *
 * This is the ONE place the codebase tolerates a bad record rather than
 * throwing, and it is a deliberate trade against data loss, not a swallowed
 * error: `read` reports how many lines it could not parse so a caller can say
 * so.
 */
export function Log(opts: LogOpts) {
    const root = opts.root

    function pathFor(id: string): string {
        return join(root, `${id}.jsonl`)
    }

    return {
        get root(): string {
            return root
        },

        /** Every job id with a log, unordered. */
        ids(): string[] {
            if (!existsSync(root)) return []
            return readdirSync(root)
                .filter(name => name.endsWith(".jsonl"))
                .map(name => name.slice(0, -".jsonl".length))
        },

        /** One job's events, oldest first, plus anything unreadable. */
        read(id: string): { events: JobEvent[]; damaged: number } {
            const path = pathFor(id)
            if (!existsSync(path)) return { events: [], damaged: 0 }

            const events: JobEvent[] = []
            let damaged = 0
            for (const line of readFileSync(path, "utf-8").split("\n")) {
                if (line.trim() === "") continue
                try {
                    events.push(JSON.parse(line) as JobEvent)
                } catch {
                    damaged++
                }
            }
            return { events: events, damaged: damaged }
        },

        /**
         * Append one event.
         *
         * Creates the log on first write, so `create` is an append like every
         * other verb rather than a separate "make the file" step that could
         * leave an empty job behind if the next write failed.
         */
        append(id: string, event: JobEvent): void {
            mkdirSync(root, { recursive: true })
            appendFileSync(pathFor(id), `${JSON.stringify(event)}\n`, "utf-8")
        },

        /**
         * Delete a job's log.
         *
         * Deliberately not exposed as a job verb: acknowledging is how a person
         * clears their list, and that keeps the history. This exists for tests
         * and for a future retention sweep, which is a policy nobody has
         * written yet.
         */
        destroy(id: string): boolean {
            const path = pathFor(id)
            if (!existsSync(path)) return false
            rmSync(path)
            return true
        },
    }
}

export type LogT = ReturnType<typeof Log>
