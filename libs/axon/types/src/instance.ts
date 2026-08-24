/**
 * One locally-running Axon process, as seen from outside it.
 *
 * Written to `<store>/running/<sessionId>.json` by the runtime at boot and
 * deleted on clean shutdown. The registry answers exactly one question —
 * *what is running right now* — and every field here is either true for the
 * whole life of the process or absent.
 *
 * Two things deliberately do NOT live here:
 *
 * - **History.** A finished run leaves no record; its session log is the
 *   durable trace. The registry is derivable from the OS (a pid is either
 *   alive or it is not), which is what makes it self-healing after `kill -9`
 *   and impossible to disagree with reality.
 * - **Anything that changes mid-run.** `runId` — the per-request id the
 *   kernel mints on every wake — belongs on the event envelope, not here: a
 *   record written once at boot could only ever hold a stale one. "Which
 *   request is this instance serving" is a read of the session tail.
 */
export type AxonInstance = {
    /** OS process id. The liveness proof: `kill(pid, 0)` is the whole check. */
    pid: number
    sessionId: string
    /** Registry identity of the agent — "@cody/barry.mk3". */
    agentName: string
    /** Absolute project root the process booted from. */
    projectRoot: string
    /** Resolved absolute data directory — the session log is at `<dataRoot>/sessions/<sessionId>.jsonl`. */
    dataRoot: string
    /** ISO timestamp of boot. */
    startedAt: string

    /**
     * Live ownership graph. A record with no `parentSessionId` is a
     * user-owned root; anything else was spawned by another instance
     * (`subagent.request`), and readers nest on this rather than rendering
     * every process as a flat sibling.
     *
     * `rootSessionId` and `depth` are denormalised from that chain because
     * the runtime enforces limits against them on every spawn
     * (MAX_LIVE_DESCENDANTS, MAX_DEPTH) and must not walk the graph to do it.
     */
    parentSessionId?: string | null
    rootSessionId?: string
    depth?: number

    /**
     * The work item this run was dispatched against, when it was
     * (`axon run --job`). Correlation only: it changes nothing about the
     * run, and exists so a reader can match a live instance to the work it
     * is answering rather than inferring it from timing.
     */
    job?: string

    /**
     * The local control channel this process is listening on, when it runs
     * a surface something can drive (the TUI does; a headless `axon run`
     * does not). Absent means "this instance cannot be controlled", which
     * is a real answer rather than a missing one.
     *
     * Both fields are written once at boot and true for the whole life of
     * the process: the port is bound before this record is written and
     * closes with the pid, so the registry's existing liveness check proves
     * the socket too. That is why discovery needs nothing beyond this field
     * — no announce protocol, no lockfile, no second watcher.
     *
     * The token exists because a listening port is reachable by any local
     * process no matter how the store is chmod'd. The 0700 store guards
     * this secret; this secret guards the socket.
     */
    control?: {
        port: number
        token: string
    }
}
