import type {
    AxonEntry,
    AxonKernelEvent,
    AxonSessionEvent,
    AxonSessionQuery,
    AxonSessionScope,
    AxonSessionSnapshot,
} from "@arcforge/types"
import { classifyEvent } from "@arcforge/types"

type MirroredSessionOpts = {
    /** Absolute base URL of ONE agent instance. */
    url: string
    /** The instance's session id, resolved during attach's handshake. */
    sessionId: string
    token?: string
    fetch?: typeof fetch
}

/** Anything carrying the monotonic per-session ordering counter. */
type Sequenced = { time: { seq: number } }

/**
 * The local mirror of a remote agent's session.
 *
 * A local runtime holds its session in memory, so the TUI reads
 * `session.entries` / `.log` / `.kernelLog` directly. A remote instance has no
 * such memory on this side of the wire, so this keeps the same three arrays and
 * fills them two ways: `hydrate()` pulls history from `GET /_axon/session`, and
 * `absorb()` appends events arriving on the SSE stream. The read surface is
 * deliberately identical to the local one — that identity is what makes a
 * deployed agent render with no second code path.
 *
 * `cursor` is the high-water `time.seq` this mirror has seen. Every write goes
 * through it, which closes the hydrate/stream race: an event emitted between the
 * snapshot read and the stream opening arrives on the stream and is kept, while
 * an event already in the snapshot is dropped if the stream replays it. `seq` is
 * monotonic per session (immune to clock skew), so this is exact rather than
 * best-effort.
 */
export function MirroredSession(opts: MirroredSessionOpts) {
    const base = opts.url.replace(/\/+$/, "")
    const doFetch = opts.fetch ?? fetch

    let entries: AxonEntry[] = []
    let log: AxonSessionEvent[] = []
    let kernelLog: AxonKernelEvent[] = []

    /**
     * null means "nothing mirrored yet", which is NOT the same as 0. The first
     * event of every session (`axon:session:opened`) carries seq 0, so a cursor
     * initialised to 0 with a `seq > cursor` filter silently dropped it on every
     * attach — the session's own opening event, gone. A nullable cursor keeps
     * "before the beginning" distinct from "at event zero".
     */
    let cursor: number | null = null

    /**
     * WHICH session the mirrored arrays belong to.
     *
     * Mutable, not the constructor's constant, because the agent behind a URL
     * can be REPLACED under a live attachment: a dev server restarting on a
     * file save boots a fresh session, and `seq` restarts at 0 with it.
     *
     * That makes a cursor from the previous session actively harmful rather
     * than merely stale — reconnecting with `?since=47` against a session
     * whose events are seq 0..12 filters out every one of them, server-side
     * and again in take(). The stream connects, reports healthy, and delivers
     * nothing: the user sends a message and watches it vanish.
     */
    let sessionId = opts.sessionId

    /**
     * The agent we reconnected to is not the one we were mirroring.
     *
     * Everything held is from a session that no longer exists, so it is
     * dropped wholesale rather than merged: the two histories share a seq
     * space by coincidence, not by meaning, and interleaving them would
     * produce a transcript that never happened.
     */
    function reset(nextSessionId: string): void {
        sessionId = nextSessionId
        entries = []
        log = []
        kernelLog = []
        cursor = null
    }

    /** Keeps only events past the cursor, so a replay can never duplicate history. */
    function fresh<T extends Sequenced>(incoming: readonly T[]): T[] {
        const mark = cursor
        return mark === null ? [...incoming] : incoming.filter(event => event.time.seq > mark)
    }

    function advance(...batches: readonly Sequenced[][]): void {
        for (const batch of batches) {
            for (const event of batch) {
                if (cursor === null || event.time.seq > cursor) cursor = event.time.seq
            }
        }
    }

    /**
     * The session id the agent reports right now, or null when it could not be
     * asked. Null is deliberately distinct from a mismatch — see the caller.
     */
    async function identify(): Promise<string | null> {
        try {
            const res = await doFetch(`${base}/_axon/health`, {
                headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
            })
            if (!res.ok) return null
            const health = (await res.json()) as { sessionId?: string }
            return health.sessionId ?? null
        } catch {
            return null
        }
    }

    async function request(query: AxonSessionQuery): Promise<AxonSessionSnapshot> {
        const params = new URLSearchParams()
        if (query.since !== undefined) params.set("since", String(query.since))
        if (query.limit !== undefined) params.set("limit", String(query.limit))
        if (query.include !== undefined) params.set("include", query.include.join(","))
        const suffix = params.size > 0 ? `?${params.toString()}` : ""

        const res = await doFetch(`${base}/_axon/session${suffix}`, {
            headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
        })
        if (!res.ok) {
            throw new Error(`_axon/session failed: ${res.status} ${await res.text().catch(() => "")}`)
        }
        return (await res.json()) as AxonSessionSnapshot
    }

    /**
     * The single write path: dedupe on the cursor, then route by classification.
     * Both absorb() and subscribe() go through this — two copies of the routing
     * rule is exactly how a classification drifts.
     */
    function take(event: Sequenced & { type: string }): boolean {
        if (cursor !== null && event.time.seq <= cursor) return false
        cursor = event.time.seq

        switch (classifyEvent(event.type)) {
            case "entries": entries = [...entries, event as AxonEntry]; break
            case "kernelLog": kernelLog = [...kernelLog, event as AxonKernelEvent]; break
            case "log": log = [...log, event as AxonSessionEvent]; break
        }
        return true
    }

    return {
        get id(): string { return sessionId },

        get entries(): readonly AxonEntry[] { return entries },
        get log(): readonly AxonSessionEvent[] { return log },
        get kernelLog(): readonly AxonKernelEvent[] { return kernelLog },

        /**
         * High-water seq mirrored so far, or null when nothing has been mirrored.
         * A reconnect resumes from here.
         */
        get cursor(): number | null { return cursor },

        /**
         * Pull history from the agent. Called once on attach, and again after a
         * dropped stream — passing the current cursor so a reconnect fetches only
         * the gap rather than the whole history again.
         */
        async hydrate(query: AxonSessionQuery = {}): Promise<AxonSessionSnapshot> {
            const snapshot = await request({ ...(cursor !== null ? { since: cursor } : {}), ...query })

            // Append rather than replace: a `since` hydrate is a delta, and a
            // full hydrate starts from empty arrays anyway.
            entries = [...entries, ...fresh(snapshot.entries)]
            log = [...log, ...fresh(snapshot.log)]
            kernelLog = [...kernelLog, ...fresh(snapshot.kernelLog)]
            advance(snapshot.entries, snapshot.log, snapshot.kernelLog)

            return snapshot
        },

        /**
         * Append one event arriving on the live stream, routed to whichever log
         * it belongs to. Returns whether it was new — a caller driving a
         * reactive view only needs to re-render when something actually landed.
         *
         * Classification comes from @arcforge/types, the same predicate core
         * uses to decide which view an event commits to. A local copy of that
         * rule here would drift the moment a new event family lands.
         */
        absorb(event: Sequenced & { type: string }): boolean {
            return take(event)
        },

        /**
         * Subscribe to the agent's ambient event stream — the remote counterpart
         * of a local `bus.onAny()`. Events are routed into the three arrays as
         * they arrive, and `onEvent` fires after each one so a reactive consumer
         * can re-render.
         *
         * The stream replays from the current cursor before going live, so this
         * both fills any gap and continues — one call, no separate hydrate, no
         * window where events fall between the two. Reconnect is the same call
         * again: the cursor has advanced, so the replay is exactly the gap.
         *
         * Returns an unsubscribe. Connection loss surfaces through `onError`
         * rather than being swallowed — a silently dead stream looks identical to
         * an idle agent, which is precisely the failure that cannot be debugged.
         */
        subscribe(handlers: SubscribeHandlers = {}): () => void {
            const controller = new AbortController()
            let closed = false

            void (async () => {
                try {
                    // Who is answering NOW — asked before resuming, because a
                    // resume is only meaningful against the session the cursor
                    // came from. Skipped on a first subscribe (cursor null):
                    // there is nothing to invalidate, and attach() just did
                    // this handshake.
                    if (cursor !== null) {
                        const live = await identify()
                        // Only on a POSITIVE mismatch. An unreachable or
                        // unparseable health response means we do not know —
                        // and discarding a user's conversation on "do not
                        // know" is the wrong way to be wrong. Resuming against
                        // the same session is harmless; the events dedupe.
                        if (live !== null && live !== sessionId) {
                            reset(live)
                            handlers.onReset?.(live)
                        }
                    }

                    const params = new URLSearchParams()
                    if (cursor !== null) params.set("since", String(cursor))
                    if (handlers.include !== undefined) params.set("include", handlers.include.join(","))
                    const suffix = params.size > 0 ? `?${params.toString()}` : ""

                    const res = await doFetch(`${base}/_axon/events${suffix}`, {
                        headers: {
                            accept: "text/event-stream",
                            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
                        },
                        signal: controller.signal,
                    })
                    if (!res.ok || !res.body) {
                        throw new Error(`_axon/events failed: ${res.status} ${await res.text().catch(() => "")}`)
                    }

                    for await (const frame of parseFrames(res.body)) {
                        if (frame.kind === "live") {
                            handlers.onLive?.(frame.cursor)
                            continue
                        }
                        if (take(frame.event)) handlers.onEvent?.(frame.event)
                    }
                    if (!closed) handlers.onClose?.()
                } catch (cause) {
                    if (closed || controller.signal.aborted) return
                    handlers.onError?.(cause instanceof Error ? cause : new Error(String(cause)))
                }
            })()

            return () => {
                closed = true
                controller.abort()
            }
        },
    }
}

export type SubscribeHandlers = {
    /** Fires after each newly absorbed event. */
    onEvent?: (event: Sequenced & { type: string }) => void
    /** Fires once replay is done and the stream is live. */
    onLive?: (cursor: number | null) => void
    /** The stream ended cleanly (agent shut down). */
    onClose?: () => void
    /**
     * The agent behind this URL is a DIFFERENT session than the one mirrored —
     * it restarted. The mirror has already dropped the old history; a consumer
     * rendering from it must re-read rather than append to what it had.
     */
    onReset?: (sessionId: string) => void
    /** The stream broke. Never swallowed — a dead stream must be visible. */
    onError?: (error: Error) => void
    /** Server-side filter, e.g. omit the kernel firehose. */
    include?: AxonSessionScope[]
}

type Frame =
    | { kind: "event"; event: Sequenced & { type: string } }
    | { kind: "live"; cursor: number | null }

/**
 * Parse the SSE body into frames. `event: live` marks the replay/live boundary;
 * everything else is a `data:` frame carrying one enveloped event.
 */
async function* parseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame, void, undefined> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            let boundary: number
            while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                const raw = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)

                const type = raw.match(/^event:\s*(.*)$/m)?.[1]?.trim()
                const data = raw.match(/^data:\s*(.*)$/m)?.[1]
                if (!data) continue

                if (type === "live") {
                    yield { kind: "live", cursor: (JSON.parse(data) as { cursor: number | null }).cursor }
                    continue
                }
                yield { kind: "event", event: JSON.parse(data) as Sequenced & { type: string } }
            }
        }
    } finally {
        reader.releaseLock()
    }
}

export type MirroredSessionHandle = ReturnType<typeof MirroredSession>
