import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

function sessionPath(root: string, sessionId: string): string {
    return path.join(root, "sessions", `${sessionId}.jsonl`)
}

async function appendLine(filePath: string, event: unknown): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true })
    await appendFile(filePath, JSON.stringify(event) + "\n")
}

/**
 * Read a JSONL file back, skipping any line that will not parse.
 *
 * appendFile is not atomic, so a hard kill (OOM, SIGKILL, power loss) mid-
 * append leaves a partial final line. Parsing strictly meant one torn line
 * made the WHOLE session unreadable — every complete event before it lost
 * with it — which is the worst possible trade for the one piece of data in
 * this system that cannot be rebuilt.
 *
 * Skipping is safe because of what a session log is: an append-only stream
 * where each line stands alone. A dropped line loses that one event, not
 * the file's structure, and `time.seq` makes the gap visible to anyone who
 * looks. Note this is deliberately NOT the same posture as the strict parse
 * the capsule wire uses — a garbage line there means the sandbox is
 * misbehaving right now and must be reported; a garbage line here is a
 * historical artifact of how the process died.
 */
async function readLines(filePath: string): Promise<unknown[]> {
    if (!existsSync(filePath)) return []
    const raw = await readFile(filePath, "utf-8")
    if (raw.trim().length === 0) return []

    const events: unknown[] = []
    for (const line of raw.trim().split("\n")) {
        if (line.trim().length === 0) continue
        try {
            events.push(JSON.parse(line))
        } catch {
            // torn or corrupt line — drop it, keep the rest of the session
        }
    }
    return events
}

/**
 * The one place that knows the data/ directory layout. AxonSession never
 * constructs paths itself — it reads/appends through here, always passing
 * the resolved `blueprint.paths.data` as `root`. No env var, no
 * module-level default: two Axon() runtimes with different paths.data must
 * never collide on the same files, and tests must be able to sandbox a run
 * into a scratch directory just by setting the blueprint.
 *
 * Convention: <root>/sessions/<sessionId>.jsonl — ONE file per session, one
 * total order. Every event the session ever records (lifecycle facts,
 * kernel telemetry, entries) appends to the same stream; classification
 * comes from the event's own type namespace (envelope rule 3), never from
 * which file it landed in — there is only one file, so the question cannot
 * exist. Readers filter: resume filters to entry types, devtools take the
 * firehose, the chat view drops telemetry. No thread/branching concept —
 * one cognet instance is always exactly one continuous stream; multiple
 * independent conversations are multiple Axon() instances (each its own
 * sessionId). The filesystem is the source of truth — a session "exists"
 * (is resumable) exactly when its file is present on disk.
 *
 * @internal
 */
export const home = {
    data: {
        sessions: {
            /** absolute path of a session's log file — the one layout fact, exported for tooling (err()'s raw fallback mirrors it) */
            path: sessionPath,

            /** true if this session has on-disk history — the resume signal */
            async exists(root: string, sessionId: string): Promise<boolean> {
                return existsSync(sessionPath(root, sessionId))
            },

            /** append one event to the session's log — the only write path */
            async append(root: string, sessionId: string, event: unknown): Promise<void> {
                await appendLine(sessionPath(root, sessionId), event)
            },

            /** read the full session log back, in order — used on resume */
            async read(root: string, sessionId: string): Promise<unknown[]> {
                return readLines(sessionPath(root, sessionId))
            },
        },

        /**
         * Private cognitive state — <root>/state/<cognet-name>/<key>.json.
         * One flat namespace per cognet; the kernel imposes no lifetime
         * taxonomy inside it. Keys are caller vocabulary, not paths:
         * encoded here so no key can ever traverse out of its namespace.
         * Writes are atomic (temp + rename) — a kill mid-write yields the
         * previous value, never a torn file. Cache doctrine: this whole
         * tree is derived state; deleting it must always be safe.
         */
        state: {
            path(root: string, cognet: string, key: string): string {
                return path.join(root, "state", cognet, `${encodeURIComponent(key)}.json`)
            },

            async read(root: string, cognet: string, key: string): Promise<unknown | null> {
                const file = this.path(root, cognet, key)
                if (!existsSync(file)) return null
                try {
                    return JSON.parse(await readFile(file, "utf-8"))
                } catch {
                    // unreadable state is a stale cache, never a crash — the
                    // owner rebuilds from the session log (cache doctrine)
                    return null
                }
            },

            async write(root: string, cognet: string, key: string, value: unknown): Promise<void> {
                const file = this.path(root, cognet, key)
                await mkdir(path.dirname(file), { recursive: true })
                const tmp = `${file}.${crypto.randomUUID().slice(0, 8)}.tmp`
                await writeFile(tmp, JSON.stringify(value))
                await rename(tmp, file)
            },
        },

    },
}
