import type { AxonError, BuildEventMap, BuildEventName } from "@arcforge/types"
import { home } from "./home"

/**
 * BuildRecorder — the session log, before there is a session to log to.
 *
 * `AxonSession` needs a blueprint: an agent id, resolved paths, a bus. The
 * build phase is what PRODUCES a blueprint, so none of that exists while
 * it runs — which is exactly why the build was untraced. A cognet ABI
 * mismatch or a failed `bun install` threw to the terminal and left
 * nothing on disk, because the session was opened by `Axon()` and `Axon()`
 * had not run yet.
 *
 * So this writes the same envelope, to the same file, needing only the two
 * facts that exist before anything else: where the data directory is, and
 * what the session is called. Everything downstream — the Events pane, the
 * flame graph, Fleet's Sessions group — reads it without knowing the
 * difference, because there is no difference in what lands on disk.
 *
 * It is deliberately NOT a second session implementation. No bus, no
 * in-memory views, no entry log, no restore. One verb — append an event —
 * because that is the whole requirement, and anything more would be a
 * parallel writer that could disagree with the real one.
 *
 * Ordering: appends are serialized through one promise chain, so disk
 * order is commit order and `seq` stays authoritative. The build is a
 * handful of events over a few seconds; a queue is enough and a bounded
 * one would be pretending the volume is a risk.
 */
export function BuildRecorder(opts: {
    /** Absolute data directory — <root>/data. Sessions live at <root>/sessions/<id>.jsonl. */
    root: string
    sessionId: string
    /** The agent's registry identity, once known. Absent until build:load has run. */
    agentId?: string
    /**
     * Observe every event on its way to the log.
     *
     * The log is the durable record, written through an async chain; a
     * surface reporting live progress needs the event as it HAPPENS, not
     * after it lands on disk. One observer here covers every emitter —
     * span() and the prepare reporter alike — so no call site has to be
     * intercepted individually.
     *
     * Never allowed to affect the build: it is called inside a try/catch and
     * its failure is swallowed, same as a write failure. This is telemetry
     * about a build that is trying to happen.
     */
    onEmit?: (type: BuildEventName, data: unknown) => void
}) {
    let seq = 0
    /** The runtime's committer, once it owns the file. See handOver(). */
    let delegate: ((type: BuildEventName, data: unknown) => void) | null = null
    let chain: Promise<void> = Promise.resolve()

    /**
     * The header goes down FIRST, before any event can append.
     *
     * It can only ever be line 1 — the log is append-only, and by the time
     * the scan reports which agent this is, thousands of lines may already
     * exist. So the file is opened with a null agent and `identify()` fills
     * it in a moment later, rather than the header waiting for a name it
     * cannot have yet.
     *
     * Queued on the same chain as the events, which is what guarantees the
     * ordering: every emit() below chains behind this.
     */
    chain = chain
        .then(() => home.data.sessions.open(opts.root, opts.sessionId, opts.agentId ?? null))
        .catch(() => {})

    return {
        /**
         * The agent's identity, learned mid-build.
         *
         * Events before `build:load` genuinely do not know which agent this
         * is — that is what the scan determines. Stamping a placeholder
         * would be worse than a null: a reader could not tell "not yet
         * known" from "an agent actually called that".
         */
        identify(name: string): void {
            // Fills the null the header was opened with. Still cheap: this
            // runs during the build, when the file is a few hundred bytes.
            //
            // A build whose scan fails before `build:load` leaves the header
            // with a null agent, which is the honest answer — that build
            // never found out which agent it was for.
            chain = chain
                .then(() => home.data.sessions.identify(opts.root, opts.sessionId, name))
                .catch(() => {})
        },

        /** One build event, enveloped and appended. Never throws — see below. */
        emit<K extends BuildEventName>(type: K, data: BuildEventMap[K]): void {
            // Observers see everything, including after handOver() — a live
            // surface cares about the event, not which writer owns the file.
            if (opts.onEmit) {
                try {
                    opts.onEmit(type, data)
                } catch {
                    // An observer's fault is never the build's.
                }
            }
            // Once the runtime owns the file, everything goes through its
            // writer — see handOver().
            if (delegate) {
                delegate(type, data)
                return
            }
            // Same envelope as the runtime's: no per-event uuid, and no
            // constant ids — those live in the header (see home.ts). A
            // build event has no runId or spanId, so it carries no context
            // key at all.
            const event = {
                type,
                time: { ms: Date.now(), seq: seq++ },
                data,
            }
            // Fire-and-forget onto the chain, and swallowing the write
            // failure is the one correct choice here: this is the telemetry
            // for a build that is trying to happen, and a full disk must
            // not turn a working build into a failed one. The build's own
            // errors still throw through their normal path — this only
            // records them.
            chain = chain
                .then(() => home.data.sessions.append(opts.root, opts.sessionId, event))
                .catch(() => {})
        },

        /**
         * The next sequence number this recorder would use.
         *
         * The runtime's session opens onto the same file part-way through
         * the build and continues its numbering from what is already there
         * — but the build is still writing (build:complete lands AFTER
         * axon:boot:start). Both counters would then issue the same values,
         * and `seq` is what every reader sorts on.
         *
         * So the recorder yields: the session takes this mark, and the
         * recorder resumes above whatever the session reaches. One total
         * order, two writers, no collision.
         */
        get seq(): number {
            return seq
        },

        /**
         * Hand the file over to the runtime's session.
         *
         * The envelope's contract is "one file, ONE serialized writer —
         * disk order IS commit order, time.seq authoritative". Two writers
         * numbering independently breaks that however carefully they are
         * coordinated: a mark read in advance is stale by the next commit,
         * and a mark read without consuming issues the same number twice.
         *
         * So the recorder stops writing and starts delegating. Build events
         * after this point (build:complete, and the reload path's warnings)
         * go through the session's own commit, which is the single writer
         * the design requires.
         */
        handOver(commit: (type: BuildEventName, data: unknown) => void): void {
            delegate = commit
        },

        /** Where this build's log is, for an error to point at. */
        get file(): string {
            return home.data.sessions.path(opts.root, opts.sessionId)
        },

        /** Wait for every queued append to land. Called before the process may exit. */
        async flush(): Promise<void> {
            await chain
        },
    }
}

export type BuildRecorderT = ReturnType<typeof BuildRecorder>

/**
 * Runs one build span: emits `:start`, then `:complete` or `:failed`,
 * whatever happens.
 *
 * The wrapper exists because instrumentation that lies is worse than none.
 * A hand-written triad drops its `:complete` on any early return and its
 * `:failed` on any throw path the author did not picture — and a flame
 * graph containing a span that never closes shows a phantom duration
 * running to the end of the log. One `finally` makes that unrepresentable:
 * a span opened here is always closed, with the error attached when there
 * is one, and `durationMs` measured across both outcomes because a call
 * that blew up after 30s is a different problem from one that blew up
 * instantly.
 */
export async function span<T>(
    recorder: BuildRecorderT | null,
    name: "build" | "build:open" | "build:prepare" | "build:load" | "build:framework"
        | "build:modules" | "build:cognet" | "build:tree" | "build:typegen" | "build:scan",
    start: Record<string, unknown>,
    run: () => Promise<T>,
    complete?: (value: T) => Record<string, unknown>,
): Promise<T> {
    if (!recorder) return run()

    const began = Date.now()
    recorder.emit(`${name}:start` as BuildEventName, start as never)
    try {
        const value = await run()
        recorder.emit(`${name}:complete` as BuildEventName, {
            ...start,
            ...(complete ? complete(value) : {}),
            durationMs: Date.now() - began,
        } as never)
        return value
    } catch (cause) {
        recorder.emit(`${name}:failed` as BuildEventName, {
            ...start,
            error: cause as AxonError,
            durationMs: Date.now() - began,
        } as never)
        throw cause
    }
}
