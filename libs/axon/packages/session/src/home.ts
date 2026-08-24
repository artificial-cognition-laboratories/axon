import { existsSync } from "node:fs"
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import type { FileHandle } from "node:fs/promises"
import path from "node:path"

/**
 * On-disk session format version.
 *
 * 2 drops the per-event `id` (uuid) and the constant `agentId`/`sessionId`
 * from every envelope, moving the latter to a header line. Version 1 files
 * are not readable by this reader and are not migrated — the format
 * changed before anyone had data worth keeping.
 */
export const SESSION_FORMAT_VERSION = 2

/** Line 1 of every session log — what is true of the whole file. */
export type SessionHeader = {
    type: "session:header"
    version: number
    /** Null until the build's scan reports it — see sessions.identify(). */
    agentId: string | null
    sessionId: string
    startedAt: string
    /**
     * A name the user gave this conversation. Absent until they do.
     *
     * On the header rather than in a sidecar index because it is a fact about
     * THIS file: copy the log somewhere else and the name travels with it,
     * which is exactly what a fork needs. An index would have to be rebuilt
     * from the logs anyway, and could disagree with them.
     */
    title?: string
    /**
     * Where this session was forked from, when it was.
     *
     * Written by `sessions.fork()` and never by the runtime. Lineage is
     * recorded at the moment it is free to record — reconstructing it later
     * from timestamps and content would be guesswork, and a fork with no
     * parent is indistinguishable from an ordinary session.
     */
    forkedFrom?: { sessionId: string; at: string }
}

function sessionPath(root: string, sessionId: string): string {
    return path.join(root, "sessions", `${sessionId}.jsonl`)
}

function sensoryDir(root: string, sessionId: string): string {
    return path.join(root, "sensory", sessionId)
}

function sensorySegment(root: string, sessionId: string, index: number): string {
    // Zero-padded so lexical order IS chronological order — a reader can
    // sort filenames without parsing them, and `ls` shows the truth.
    return path.join(sensoryDir(root, sessionId), `${String(index).padStart(6, "0")}.jsonl`)
}

/**
 * Open append handles, keyed by absolute path.
 *
 * `appendFile` opens, writes and closes on EVERY call. At 30Hz across ~19
 * events a tick that is ~570 open/write/close triples a second for a file
 * that stays the same all session — measured at 19µs an event, against
 * 1.8µs for a held handle (10x).
 *
 * The handle is cached rather than owned by a session object because
 * `home` is the only thing that knows the layout, and several writers
 * (the log's Writer, the error queue, the sensory ring) append to paths it
 * derives. One handle per path keeps them sharing an fd instead of
 * reopening around each other.
 *
 * Correctness rests on the O_APPEND semantics `appendFile` already relied
 * on: every write lands at the current end of file atomically for the
 * write's length, so interleaved writers cannot tear each other's lines.
 * The ordering guarantee callers depend on comes from Writer's queue, not
 * from the file handle.
 */
const handles = new Map<string, Promise<FileHandle>>()

function handleFor(filePath: string): Promise<FileHandle> {
    const existing = handles.get(filePath)
    if (existing) return existing

    const opening = mkdir(path.dirname(filePath), { recursive: true })
        .then(() => open(filePath, "a"))
        .catch(cause => {
            // A failed open must not poison the cache — the next append
            // should retry rather than reject forever against a directory
            // that may since have been created.
            handles.delete(filePath)
            throw cause
        })

    handles.set(filePath, opening)
    return opening
}

async function appendLine(filePath: string, event: unknown): Promise<void> {
    const handle = await handleFor(filePath)
    await handle.write(JSON.stringify(event) + "\n")
}

/**
 * Close a session's handles.
 *
 * Called on shutdown, after the writers have drained. Not closing would
 * leak an fd per session in a long-lived process (the TUI opens many), and
 * the data is already durable — `write` on an O_APPEND handle has reached
 * the OS by the time it resolves; close only releases the descriptor.
 */
async function closeHandles(prefix: string): Promise<void> {
    for (const [filePath, opening] of [...handles]) {
        if (!filePath.startsWith(prefix)) continue
        handles.delete(filePath)
        await opening.then(handle => handle.close()).catch(() => {
            // Already closed, or never opened — either way the fd is not ours
            // to worry about, and shutdown must not fail on cleanup.
        })
    }
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
            const parsed = JSON.parse(line)
            // The header describes the file, it is not something that
            // happened in it — a reader rebuilding the event log must not
            // see it as an event. Callers who want it ask for it by name.
            if (parsed?.type === "session:header") continue
            events.push(parsed)
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

            /**
             * Write the file's header, if it has none yet.
             *
             * The header is line 1 and holds what is TRUE OF THE WHOLE FILE:
             * the agent, the session, the format version. Those were
             * previously stamped onto every event, which measured at 36% of
             * a real 302MB log — a constant repeated a million times.
             *
             * `type: "session:header"` rather than a bare object so the line
             * is self-describing: a reader that hits it mid-stream (tailing
             * from byte 0) classifies it by the same `type` switch it uses
             * for everything else, and tooling that does not know about
             * headers skips one unrecognised line instead of misreading a
             * bare `{agentId}` as an event.
             *
             * `agentId` is null when the file is created, because the first
             * thing that writes to a session is the BUILD — and which agent
             * this is, is what the build's scan determines. It is filled in
             * by `identify()` the moment the scan answers. A null there
             * means "not known yet", which is honestly different from a
             * placeholder name that could be mistaken for a real one.
             *
             * Must be called BEFORE the first append, since the header can
             * only be line 1 and a session log is append-only — there is no
             * rewriting a 300MB file to insert one.
             */
            async open(root: string, sessionId: string, agentId: string | null): Promise<void> {
                const file = sessionPath(root, sessionId)
                if (existsSync(file)) return
                await appendLine(file, {
                    type: "session:header",
                    version: SESSION_FORMAT_VERSION,
                    agentId,
                    sessionId,
                    startedAt: new Date().toISOString(),
                })
            },

            /**
             * Fill in the header's agent, once the build's scan knows it.
             *
             * Rewrites ONLY the first line, and only while it is still the
             * whole file or a small prefix — this runs during the build,
             * within the first few hundred bytes, long before the log grows.
             * A no-op if there is no header or the agent is already set.
             */
            async identify(root: string, sessionId: string, agentId: string): Promise<void> {
                const file = sessionPath(root, sessionId)
                if (!existsSync(file)) return
                const current = await readFile(file, "utf-8")
                const newline = current.indexOf("\n")
                if (newline < 0) return
                let head: SessionHeader
                try {
                    head = JSON.parse(current.slice(0, newline)) as SessionHeader
                } catch {
                    return
                }
                if (head.type !== "session:header" || head.agentId) return
                const rewritten = JSON.stringify({ ...head, agentId }) + current.slice(newline)
                // Rewritten through a temp + rename so a reader tailing the
                // file never observes it half-written, and so a crash here
                // cannot leave a truncated log.
                const tmp = `${file}.${Math.random().toString(36).slice(2, 10)}.tmp`
                await writeFile(tmp, rewritten)
                // The cached append handle points at the OLD inode, which
                // rename() is about to orphan — every subsequent append
                // would land in a file nothing can see. Dropped first, so
                // the next append reopens onto the new one.
                await closeHandles(file)
                await rename(tmp, file)
            },

            /** append one event to the session's log — the only write path */
            async append(root: string, sessionId: string, event: unknown): Promise<void> {
                await appendLine(sessionPath(root, sessionId), event)
            },

            /** read the full session log back, in order — used on resume */
            async read(root: string, sessionId: string): Promise<unknown[]> {
                return readLines(sessionPath(root, sessionId))
            },

            /**
             * The header, or null for a file that has none.
             *
             * Reads only the first line — a session log is hundreds of
             * megabytes and the answer is always in the first few hundred
             * bytes.
             */
            async header(root: string, sessionId: string): Promise<SessionHeader | null> {
                const file = sessionPath(root, sessionId)
                if (!existsSync(file)) return null
                const handle = await open(file, "r")
                try {
                    const buffer = Buffer.alloc(1024)
                    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
                    const newline = buffer.indexOf(0x0a)
                    if (newline < 0 || newline > bytesRead) return null
                    const parsed = JSON.parse(buffer.subarray(0, newline).toString("utf-8"))
                    return parsed?.type === "session:header" ? parsed as SessionHeader : null
                } catch {
                    return null
                } finally {
                    await handle.close()
                }
            },
        },

        /**
         * The sensory ring — <root>/sensory/<sessionId>/<nnnnnn>.jsonl.
         *
         * The middle retention tier. Dense sense streams (audio, visual) are
         * too voluminous for the permanent record and too useful to discard
         * at the moment they arrive: you debug a voice agent by WATCHING it,
         * live or a minute later, and never by reading frame 14,203 out of
         * last Tuesday's log. So they land here, bounded, and age out.
         *
         * SEGMENTED, because eviction must be O(1). Dropping the head of a
         * single append-only file means rewriting the whole file, which at
         * 30Hz is a rewrite every few seconds and quickly costs more than
         * the capture. Rolling to a new segment at a fixed size makes
         * eviction an unlink of the oldest whole file — no rewrite, ever.
         *
         * A directory rather than one file also means a reader watching it
         * sees appends to the newest segment and deletions of the oldest
         * through the same fs.watch it already uses on `sessions/`.
         *
         * Deleting this whole tree must always be safe: nothing here is the
         * record. It is a window, and a window that closed is not data loss.
         */
        sensory: {
            dir: sensoryDir,

            /** absolute path of one segment — the ring never builds this itself */
            segment: sensorySegment,

            /** every segment, oldest first — lexical order is chronological (see sensorySegment) */
            async segments(root: string, sessionId: string): Promise<string[]> {
                const dir = sensoryDir(root, sessionId)
                if (!existsSync(dir)) return []
                const names = await readdir(dir)
                return names
                    .filter(name => name.endsWith(".jsonl"))
                    .sort()
                    .map(name => path.join(dir, name))
            },

            /** append one entry to a specific segment — the ring picks the index */
            async append(root: string, sessionId: string, index: number, entry: unknown): Promise<void> {
                await appendLine(sensorySegment(root, sessionId, index), entry)
            },

            /** byte size of one segment, or 0 if it does not exist yet */
            async size(root: string, sessionId: string, index: number): Promise<number> {
                const file = sensorySegment(root, sessionId, index)
                if (!existsSync(file)) return 0
                return (await stat(file)).size
            },

            /** drop the oldest segment — the eviction primitive */
            async evict(file: string): Promise<void> {
                if (existsSync(file)) await unlink(file)
            },

            /** read one segment back, in order — same torn-line tolerance as the log */
            async read(file: string): Promise<unknown[]> {
                return readLines(file)
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

    /**
     * Release every append handle under one data root.
     *
     * Called at the end of shutdown, after writers have drained. The data
     * is durable before this runs — closing only frees the descriptor.
     */
    async close(root: string): Promise<void> {
        await closeHandles(root)
    },
}
