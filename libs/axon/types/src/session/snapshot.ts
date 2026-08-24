import type { AxonEntry, AxonKernelEvent, AxonSessionEvent } from "./session"

/**
 * The wire form of a session — what `GET /_axon/session` returns and what a
 * remote client hydrates from.
 *
 * This exists so a deployed agent renders identically to a local one. The TUI
 * reads `entries` / `log` / `kernelLog` off a live local runtime; a remote
 * instance has no such memory, so it fetches this once on attach and then
 * appends from the SSE stream. Same arrays, same shapes, one rendering model
 * either side of the wire.
 *
 * `cursor` is the high-water `time.seq` across everything included. It closes
 * the hydrate/stream race: events emitted between the snapshot read and the
 * stream opening would otherwise be lost or double-counted. A client keeps the
 * cursor, drops any streamed event at or below it, and passes it back as
 * `?since=` on reconnect. `seq` is a monotonic per-session counter (immune to
 * clock skew), which is what makes this ordering authoritative rather than
 * best-effort.
 */
export type AxonSessionSnapshot = {
    id: string
    entries: AxonEntry[]
    /** Runtime/continuity facts — boot, shutdown, errors. */
    log: AxonSessionEvent[]
    /**
     * Internal tick/phase/system telemetry. Included by default: the client is
     * fully trusted with its own agent's data and decides what to render. Ask
     * for `?include=entries,log` to omit it — a long-lived agent's kernel log is
     * the firehose and dwarfs everything else.
     */
    kernelLog: AxonKernelEvent[]
    /** High-water time.seq across the returned events. 0 when nothing is included. */
    cursor: number
    /**
     * True when a `limit` capped one of the logs, so the client knows its view
     * is a tail rather than the whole history. Never silently truncate without
     * saying so — a partial log that claims to be complete is a lie the UI
     * cannot detect.
     */
    truncated: boolean
}

/** Which logs a snapshot request wants. Absent means all three. */
export type AxonSessionScope = "entries" | "log" | "kernelLog"

export type AxonSessionQuery = {
    /** Only events with `time.seq` strictly greater than this. */
    since?: number
    /** Max events per log, keeping the most recent. */
    limit?: number
    /** Which logs to include. Defaults to all. */
    include?: AxonSessionScope[]
}
