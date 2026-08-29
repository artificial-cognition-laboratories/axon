import type { AxonEntry, AxonMirroredSession, AxonSessionHandlers } from "@arcforge/types"

type MirrorOpts = {
    /** The supervisor-held log this mirrors. Read-only from here. */
    session: {
        readonly entries: readonly AxonEntry[]
        readonly log: readonly unknown[]
        readonly kernelLog: readonly unknown[]
    }
    /** Where commits announce. The supervisor's own bus for this agent. */
    bus: { onAny(handler: (type: string, data: unknown) => void): () => void }
}

/**
 * The in-process mirror — an agent's log, as `AxonAgentHandle` exposes it.
 *
 * ── Why mirror something already in memory ──────────────────────────────────
 *
 * The daemon holds the REAL session for an agent it supervises, and could
 * expose it directly. That asymmetry is exactly what made surfaces
 * accidentally local-only: code written against a live `AxonSessionT` compiles
 * here and cannot work against an agent on another machine, and nothing says
 * so until someone tries.
 *
 * So the local case presents the same read surface as the remote one. It costs
 * almost nothing — the arrays are already here and this only re-shapes them —
 * and it buys every surface working against any agent.
 *
 * ── No reset, deliberately ──────────────────────────────────────────────────
 *
 * `onReset` fires when the agent behind a URL turns out to be a DIFFERENT
 * session. In-process that cannot happen: the handle is bound to one
 * supervised agent, and a restart produces a new handle rather than the same
 * one pointing somewhere new. The callback is accepted and never called, which
 * is the honest implementation rather than a missing one.
 */
export function Mirror(opts: MirrorOpts): AxonMirroredSession {
    /** How much has been seen. The log's length is the only honest local analogue of a cursor. */
    function cursor(): number | null {
        return opts.session.log.length > 0 ? opts.session.log.length : null
    }

    return {
        get entries(): readonly AxonEntry[] {
            return opts.session.entries
        },
        get log(): readonly unknown[] {
            return opts.session.log
        },
        get kernelLog(): readonly unknown[] {
            return opts.session.kernelLog
        },
        get cursor(): number | null {
            return cursor()
        },

        subscribe(handlers: AxonSessionHandlers): () => void {
            const stop = opts.bus.onAny((type, data) => {
                handlers.onEvent?.({ type: type, ...(data as Record<string, unknown>) })
            })

            // Everything already in the log IS the replay, and it has already
            // happened — so live begins immediately rather than after a
            // hydration round trip the local case does not have.
            handlers.onLive?.(cursor())

            return stop
        },
    }
}
