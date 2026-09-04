import { closeSync, openSync, readSync } from "node:fs"
import { ENTRY_EVENT_PREFIXES } from "@arcforge/types"

/** One resumable session on disk — the durable record of a past (or current) conversation. */
export type SessionRecord = {
    sessionId: string
    /**
     * The agent's IDENTITY — `package.json`'s name (`@cody/barry.mk3`),
     * falling back to the directory name when there is no readable manifest.
     *
     * Not the folder. It used to be, and the doc said "the agent project's
     * name" — a phrase true of both readings, which is how a consumer came to
     * compare it against a directory name and match nothing. `^` filtered
     * `record.agent === "barry.mk3"` against `"@cody/barry.mk3"` and reported
     * "no past sessions" for an agent with 216 of them; the unscoped agents on
     * the same machine matched fine, so it looked intermittent rather than
     * broken.
     *
     * This is the one true name for an agent: compare it against another
     * identity (`project.name`), never against a directory.
     */
    agent: string
    /** absolute path to the session's <id>.jsonl — read directly to preview without booting */
    filePath: string
    /** last write to the log — orders "most recent conversation first" */
    modifiedAt: number
    /** size of the log on disk, in bytes — a rough proxy for how much conversation happened */
    sizeBytes: number
    /** a live instance is running over this log right now */
    running: boolean
    /** true when the log contains at least one user/agent/action timeline entry */
    hasEntries: boolean
    /**
     * The name the user gave this conversation, from its header. Null when
     * unnamed, which is almost all of them — a title is opt-in.
     */
    title: string | null
    /**
     * The session this one was forked from, or null for an ordinary session.
     *
     * Written into the header by `fork()` and never by the runtime, so it is
     * recorded lineage rather than an inference. This is what lets `^` render
     * history as a TREE — the parent relation forks branch along, which is a
     * different relation from the one sub-agents nest along in `/`.
     */
    forkedFrom: string | null
}

/** What the listing needs from a session's header line. */
export type SessionHead = {
    title: string | null
    forkedFrom: string | null
}

/**
 * The listable fields of line 1, without reading the rest of the file.
 *
 * A session log can be megabytes and this runs once per session on every
 * listing, so it reads a small prefix rather than the whole file. The header is
 * always line 1 (see @arcforge/session's home.ts), so a prefix is sufficient by
 * construction rather than by luck.
 *
 * One function for both fields rather than one per field: they come off the
 * same parsed object, and a second reader would open, read and JSON-parse the
 * same bytes again for every session on every listing.
 */
export function sessionHead(file: string): SessionHead {
    const fd = openSync(file, "r")
    const buffer = Buffer.allocUnsafe(8 * 1024)
    try {
        const bytes = readSync(fd, buffer, 0, buffer.length, 0)
        if (bytes === 0) return NO_HEAD
        const chunk = buffer.toString("utf-8", 0, bytes)
        const newline = chunk.indexOf("\n")
        if (newline < 0) return NO_HEAD
        const head = JSON.parse(chunk.slice(0, newline)) as {
            type?: string
            title?: unknown
            forkedFrom?: { sessionId?: unknown }
        }
        if (head.type !== "session:header") return NO_HEAD
        return {
            title: typeof head.title === "string" && head.title.length > 0 ? head.title : null,
            forkedFrom: typeof head.forkedFrom?.sessionId === "string" ? head.forkedFrom.sessionId : null,
        }
    } catch {
        // A header that is absent, truncated or not JSON is not an error here:
        // the session is still listable and resumable, it simply has no name
        // and no recorded lineage.
        return NO_HEAD
    } finally {
        closeSync(fd)
    }
}

const NO_HEAD: SessionHead = { title: null, forkedFrom: null }

/**
 * The byte patterns that prove a log holds a real timeline entry.
 *
 * DERIVED from `ENTRY_EVENT_PREFIXES` rather than written out, because that
 * constant is the single registry of which event families may appear in a
 * session log, and it says so: anything answering "is this a log entry?"
 * derives from it, never from its own prefix sniff.
 *
 * This list WAS written out by hand, and drifted exactly the way that rule
 * predicts. `axon:agent:done` was added to the registry and not here, so a
 * session whose only entries were the agent declaring its turn over reported
 * `hasEntries: false` — it existed, it had run, and it was filtered out of
 * every listing that asks this question. Deriving costs one map() and makes
 * the next family added to the registry impossible to miss.
 */
const ENTRY_TYPE_MARKERS = ENTRY_EVENT_PREFIXES.map(prefix => `"type":"${prefix}`)

/** Session files are compact JSONL authored by core; stop scanning as soon as the first entry appears. */
export function sessionHasEntries(file: string): boolean {
    const fd = openSync(file, "r")
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const overlap = Math.max(...ENTRY_TYPE_MARKERS.map(marker => marker.length)) - 1
    let carry = ""
    try {
        while (true) {
            const bytes = readSync(fd, buffer, 0, buffer.length, null)
            if (bytes === 0) return false
            const chunk = carry + buffer.toString("utf-8", 0, bytes)
            if (ENTRY_TYPE_MARKERS.some(marker => chunk.includes(marker))) return true
            carry = chunk.slice(-overlap)
        }
    } finally {
        closeSync(fd)
    }
}

/**
 * Is this session worth listing?
 *
 * The predicate every surface listing sessions asks — Fleet's shelf and the
 * TUI's `^` palette both, so it lives beside the record it tests rather than
 * in either one of them.
 *
 * `hasEntries` is the baseline: it hides logs that were opened and never
 * spoken into, so a list is not mostly empty boots. But it is a PROXY for "a
 * person did something here", and it misses two cases where they demonstrably
 * did:
 *
 * - **running** — a session boots with a header and build events but no
 *   timeline entry until the first message, so the conversation you are
 *   SITTING IN is absent from its own history until you speak. A live
 *   instance is proof a person caused this to exist.
 * - **forkedFrom** — a fork is an explicit act. Forking a blank session
 *   copies a log with no entries, and `:session fork` deliberately does not
 *   switch to it, so it failed both other tests and vanished — the one
 *   command whose whole purpose is to leave something behind.
 *
 * The rule is "a person caused this to exist". Entries alone do not express it.
 */
export function isListableSession(record: Pick<SessionRecord, "hasEntries" | "running" | "forkedFrom">): boolean {
    return record.hasEntries || record.running || record.forkedFrom !== null
}
