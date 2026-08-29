import { err } from "@arcforge/err"
import type { AxonAgentHandle, AxonStimulusEntry } from "@arcforge/types"
import type { AgentRecord } from "./types"

type InstanceOpts = {
    record: AgentRecord
    /**
     * The agent contract, when THIS daemon supervises it.
     *
     * Absent for an agent it merely observes — one booted by a terminal that
     * still holds its own link. Those are listable and killable and cannot be
     * spoken to, which is the honest state rather than a stub that accepts a
     * message and drops it.
     */
    handle?: AxonAgentHandle
    /** Re-read from the registry, so a handle reports what is true now. */
    refresh: (sessionId: string) => AgentRecord | null
    /** Signal the process. Owned by the registry's parent, which knows the roots. */
    signal: (sessionId: string, signal: NodeJS.Signals) => boolean
}

/**
 * Instance — ONE agent, as a handle.
 *
 * ── Why a handle and not a record ───────────────────────────────────────────
 *
 * `agents.at(id)` returns something you can TALK TO. That is the whole reason
 * the shape is worth deciding now rather than later: an SDK where a user gets
 * an agent and says something to it is this surface with documentation, while
 * a flat `daemon.request(id, msg)` would need a translation layer invented on
 * top of it.
 *
 * ── What is live and what is not ────────────────────────────────────────────
 *
 * `record`, `alive` and `stop` work today: they read the registry and signal a
 * pid, neither of which needs the daemon to have started the process.
 *
 * `say`, `request` and `events` do NOT. They need the supervisor link, which
 * belongs to whoever spawned the agent — and that is still the platform. They
 * throw rather than returning nothing, because a stub that answered emptily
 * would be indistinguishable from an agent with nothing to say.
 */
export function Instance(opts: InstanceOpts) {
    const sessionId = opts.record.sessionId

    /**
     * The agent contract, or a refusal naming why there is none.
     *
     * An observed agent has a live supervisor in another process; reaching it
     * needs that process, not this one. Saying so beats a verb that appears to
     * work — and it is exactly the gap that closes when every agent is
     * daemon-supervised.
     */
    function contract(): AxonAgentHandle {
        if (opts.handle) return opts.handle
        throw err("DAEMON_NOT_WIRED", {
            detail: "this daemon observes that agent but does not supervise it — its link belongs to the process that spawned it",
            context: { sessionId: sessionId },
        })
    }

    return {
        /** Session id — the agent's identity everywhere in Axon. */
        id: sessionId,

        /**
         * The record as it stands NOW, or null once the agent has gone.
         *
         * Re-read rather than captured: a handle held across a shutdown must
         * report the shutdown, not the state it was built from.
         */
        record(): AgentRecord | null {
            return opts.refresh(sessionId)
        },

        /** Whether the process is still there. */
        alive(): boolean {
            return opts.refresh(sessionId) !== null
        },

        /**
         * Ask the agent to shut down.
         *
         * Through the LINK when this daemon supervises — that drains the wake
         * and closes the session log, where a signal leaves both hanging.
         * Falls back to SIGTERM for an observed agent, which is the only
         * lever this process has over one it does not own.
         */
        stop(): boolean {
            return opts.signal(sessionId, "SIGTERM")
        },

        /**
         * Whether this daemon supervises the agent, or merely sees it.
         *
         * The difference decides which verbs work, so it is reported rather
         * than discovered by calling one and being refused.
         */
        get supervised(): boolean {
            return opts.handle !== undefined
        },

        /**
         * The agent contract — the same surface a deployment and a remote
         * daemon present. Throws when this daemon only observes.
         */
        get agent(): AxonAgentHandle {
            return contract()
        },

        /** Deliver a stimulus. Resolves on admission. */
        stimulus(entry: AxonStimulusEntry) {
            return contract().stimulus(entry)
        },

        /** Deliver a stimulus and wait for the wake it caused to settle. */
        request(entry: AxonStimulusEntry) {
            return contract().request(entry)
        },

        /** Deliver a stimulus and iterate what it produces. */
        stream(entry: AxonStimulusEntry) {
            return contract().stream(entry)
        },

        /** The agent's log, as every transport exposes it. */
        get session() {
            return contract().session
        },
    }
}

export type InstanceT = ReturnType<typeof Instance>
