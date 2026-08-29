/**
 * The daemon's own types — what it IS, rather than what it manages.
 *
 * Domain types (a resident model, an instance record) live beside their
 * domain's types file. These are the ones every domain and both roots need:
 * where the daemon lives, whether it is up, and how a client reaches it.
 */

/** Where the daemon keeps its socket, pidfile and logs. */
export type DaemonPaths = {
    /** The directory holding everything below. `~/.axon/cache/daemon` by default. */
    root: string
    /** Unix socket every client connects to. */
    socket: string
    /** Holds the running pid — how `status` answers without a connection. */
    pid: string
    /** Where a detached daemon's stdout and stderr land. */
    log: string
}

/**
 * Whether a daemon is running, and what it is.
 *
 * `running: false` carries no other field — a stopped daemon has no pid and no
 * uptime, and reporting zero for either would make "down" and "just started"
 * the same reading.
 */
export type DaemonStatus =
    | { running: false }
    | {
        running: true
        pid: number
        /** Seconds since start. */
        uptime: number
        version: string
        /** Absolute path to the socket clients are connecting on. */
        socket: string
    }

/** What `up()` reports back. */
export type DaemonStarted = {
    pid: number
    socket: string
    /**
     * True when a daemon was ALREADY running and this call did nothing.
     *
     * Distinct from a fresh start because `axon daemon up` on a live daemon is
     * a no-op a person should be told about, not a silent success that looks
     * like it restarted something.
     */
    already: boolean
}
