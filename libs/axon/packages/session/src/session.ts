import { errScope } from "@arcforge/err"
import { isBuildEvent, isEntryEvent, isKernelEvent, STIMULUS_TRANSIENT_EVENTS } from "@arcforge/types"
import type {
    AxonBlueprint,
    AxonEntry,
    AxonEntryEvent,
    AxonEventContext,
    AxonEventMap,
    AxonKernelEvent,
    AxonSessionEvent,
    AxonStimulusEntry,
    AxonStimulusEvent,
    AxonStimulusType,
} from "@arcforge/types"
import { home } from "./home"
import path from "node:path"

/**
 * The only thing a session needs from an event bus: somewhere to announce what
 * it just committed. Declared structurally rather than imported so the session
 * package doesn't depend on a bus implementation — anything with forward()
 * satisfies it, and the real AxonBusT does.
 */
export type SessionBus = {
    forward(event: { type: string }): Promise<void>
}

type AxonSessionOpts = {
    blueprint: AxonBlueprint
    bus: SessionBus
}

/** Correlation a caller may attach to a commit — everything else is stamped here. */
type CommitContext = Partial<Pick<AxonEventContext, "runId" | "spanId">>

// ── Writer ────────────────────────────────────────────────────────────────────

/**
 * Serialized fs appender: one queue per session, so disk order is commit
 * order — the one file's line order IS the session's total order.
 * push() resolves when THIS append is durable and rethrows its failure at
 * the caller; a failed append never breaks the chain for later commits.
 */
function Writer() {
    let tail: Promise<void> = Promise.resolve()

    return {
        push(job: () => Promise<void>): Promise<void> {
            const done = tail.then(job)
            tail = done.catch(() => {}) // chain survives; the caller still sees the rejection
            return done
        },
        /** wait for every queued append to land */
        drain(): Promise<void> {
            return tail
        },
    }
}

/** drain() must never hang shutdown indefinitely — race it against a hard ceiling. */
const DRAIN_TIMEOUT_MS = 5_000

async function drainWithTimeout(writer: ReturnType<typeof Writer>, label: string): Promise<void> {
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<void>(resolve => {
        timer = setTimeout(() => {
            console.error(`session: ${label} drain exceeded ${DRAIN_TIMEOUT_MS}ms — proceeding without waiting further`)
            resolve()
        }, DRAIN_TIMEOUT_MS)
    })
    try {
        await Promise.race([writer.drain(), timeout])
    } finally {
        clearTimeout(timer!)
    }
}

/**
 * Background error telemetry: bounded, best-effort, lossy under pressure.
 * Every AxonError thrown anywhere in the process lands here via the error
 * sink — that can happen far faster than disk append completes, so this
 * queue caps in-flight depth and drops the oldest pending write rather than
 * growing the tail chain forever. Losing an old error record under sustained
 * error pressure is an acceptable tradeoff; hanging shutdown for minutes is not.
 */
const ERROR_QUEUE_MAX = 200

function ErrorQueue() {
    const writer = Writer()
    let depth = 0

    return {
        push(job: () => Promise<void>): void {
            if (depth >= ERROR_QUEUE_MAX) return // drop: queue saturated, disk can't keep up
            depth++
            void writer.push(job).finally(() => { depth-- })
        },
        drain(): Promise<void> {
            return drainWithTimeout(writer, "error queue")
        },
    }
}

// ── Stimuli ──────────────────────────────────────────────────────────────────

/**
 * The stimuli buffer — NOT the entry log. This is an ephemeral delivery
 * queue answering "what's new since the scheduler last checked", the way a
 * process's stdin fd is not the same object as the audit log recording that
 * data arrived. drain() only ever touches this queue.
 *
 * Whether a stimulus ALSO reaches the durable record depends on its kind
 * (STIMULUS_TRANSIENT_EVENTS): text and field readings are sparse and worth
 * remembering, audio and visual frames are a live sensor's firehose and are
 * delivered only. Either way this queue behaves identically — a cognet
 * cannot tell which kind it received, and should not need to.
 *
 * One queue, not keyed — one cognet instance is always exactly one
 * continuous stream, so there is nothing to address by id.
 *
 * Delete-on-consumption by design: once handed to a wake, an entry is gone
 * from the queue. A cognet that wants to keep it must carry it into its own
 * derived state during that wake — the queue gives no second chance, same
 * as a brain doesn't get to re-fetch a sensation after the moment passes.
 */
function Stimuli() {
    let queue: AxonStimulusEntry[] = []

    return {
        /** @internal called only from ingest() below, after the entry commit lands */
        _push(entry: AxonStimulusEntry): void {
            queue.push(entry)
        },

        /** everything queued since the last drain, in order — clears the queue */
        drain(): AxonStimulusEntry[] {
            if (queue.length === 0) return []
            const drained = queue
            queue = []
            return drained
        },
    }
}

// ── SessionState ──────────────────────────────────────────────────────────────

type SessionStateOpts = {
    sessionId: string
    agentId: string
    /** resolved absolute path — blueprint.paths.root + blueprint.paths.data */
    root: string
    bus: SessionBus
}

/**
 * One loaded session: the in-memory projection of one session file.
 *
 * Disk is ONE file (<root>/sessions/<id>.jsonl, one total order); the three
 * in-memory views (log / kernelLog / entries) are read projections
 * classified from each event's type namespace on the way through — never a
 * storage fact. Load = read the file once, classify each line into its
 * view, restore the seq high-water mark. Eager hydration is deliberate:
 * seq is the authoritative per-session ordering and must account for every
 * existing event before the first new commit.
 *
 * All writes go through one pipeline: stamp envelope → cache in the right
 * view → durable append via Writer → bus.forward. Observers only ever see
 * events that are already on disk.
 */
async function SessionState(opts: SessionStateOpts) {
    const writer = Writer()
    const errorQueue = ErrorQueue()
    const reportedErrors = new WeakSet<object>()
    const stimuli = Stimuli()
    const log: AxonSessionEvent[] = []
    const kernelLog: AxonKernelEvent[] = []
    const entries: AxonEntry[] = []
    let seq = 0

    // ── envelope stamping — the one place id/time/context are minted ────────

    function envelope(type: string, data: unknown, ctx?: CommitContext) {
        return {
            id: Bun.randomUUIDv7(),
            type,
            time: { ms: Date.now(), seq: seq++ },
            context: {
                agentId: opts.agentId,
                sessionId: opts.sessionId,
                ...(ctx?.runId ? { runId: ctx.runId } : {}),
                ...(ctx?.spanId ? { spanId: ctx.spanId } : {}),
            },
            data,
        }
    }

    // ── the write pipeline ───────────────────────────────────────────────────

    /**
     * Session-level commit: stamp → cache → durable → announce. Disk is one
     * file regardless; the type's own namespace only decides which in-memory
     * view caches it (kernel telemetry vs runtime/continuity facts).
     */
    async function commit<K extends keyof AxonEventMap>(
        type: K,
        data: AxonEventMap[K],
        ctx?: CommitContext,
    ): Promise<AxonSessionEvent | AxonKernelEvent> {
        const event = envelope(type, data, ctx)

        if (isKernelEvent(type as string)) kernelLog.push(event as AxonKernelEvent)
        else log.push(event as AxonSessionEvent)

        await writer.push(() => home.data.sessions.append(opts.root, opts.sessionId, event))
        await opts.bus.forward(event as AxonSessionEvent)
        return event as AxonSessionEvent | AxonKernelEvent
    }

    /**
     * Background error telemetry: stamps and caches synchronously (so `log`
     * reflects the error immediately) but queues the disk append on the
     * bounded error queue, not the ordered writer — a burst of errors must
     * never make the session's own commit chain (and thus shutdown) grow
     * without limit.
     */
    function commitError(data: AxonEventMap["axon:error"]): void {
        if (typeof data.error === "object" && data.error !== null) {
            if (reportedErrors.has(data.error)) return
            reportedErrors.add(data.error)
        }
        const event = envelope("axon:error", data) as AxonSessionEvent
        log.push(event)
        errorQueue.push(() => home.data.sessions.append(opts.root, opts.sessionId, event))
        opts.bus.forward(event).catch(() => {}) // best-effort announce; never blocks the throw site
    }

    /**
     * Entry-log commit: same pipeline, the one entry log file + in-memory
     * cache.
     *
     * Generic in K so the payload is checked against the SPECIFIC entry
     * type, not the union of all of them. A non-generic signature
     * (`type: keyof AxonEntryEvent, data: AxonEntryEvent[keyof ...]`)
     * collapses to a union that accepts any member's payload for any
     * member's type — which let a malformed entry (a visual output with
     * only `content`, no `ref`) type-check and reach disk.
     */
    async function commitEntry<K extends keyof AxonEntryEvent>(
        type: K,
        data: AxonEntryEvent[K],
        ctx?: CommitContext,
    ): Promise<AxonEntry> {
        const entry = envelope(type, data, ctx) as AxonEntry
        entries.push(entry)
        await writer.push(() => home.data.sessions.append(opts.root, opts.sessionId, entry))
        await opts.bus.forward(entry)
        return entry
    }

    /**
     * Ingest a stimulus: commits it to the entry log (durable, permanent
     * record — identical to any other entry commit) and, in the same call,
     * queues it on the scheduler's delivery buffer. Many trusted producers
     * call this (capsule tools, plugins, a future AxonHandle surface); the
     * scheduler is the buffer's one drainer.
     */
    async function ingest<K extends AxonStimulusType>(
        type: K,
        data: AxonStimulusEvent[K],
        ctx?: CommitContext,
    ): Promise<AxonEntry> {
        // A transient stimulus is STAMPED but never written: it gets a real
        // envelope (id, seq, context) so the cognet receives an entry
        // indistinguishable from any other, and the log never sees it. See
        // STIMULUS_TRANSIENT_EVENTS for why durability belongs to the kind.
        //
        // Note the seq is still consumed. The stimulus is a real event that
        // really happened, and skipping the counter would make two durable
        // entries look adjacent when a sensation occurred between them.
        //
        // AxonEntryEvent is an intersection that CONTAINS AxonStimulusEvent,
        // so for any K in AxonStimulusType the two payload types are the same
        // type — TS just can't prove it through the intersection for a generic
        // K. Narrowed to this one key rather than the old union-wide cast.
        const entry = STIMULUS_TRANSIENT_EVENTS.has(type)
            ? envelope(type, data, ctx) as AxonEntry
            : await commitEntry(type, data as AxonEntryEvent[K], ctx)
        // commitEntry returns the general AxonEntry shape (shared machinery
        // for every commit); K constrained to AxonStimulusType guarantees
        // this specific entry is stimulus-shaped.
        stimuli._push(entry as AxonStimulusEntry)
        return entry
    }

    /**
     * The next sequence number. Read by a BuildRecorder still writing into
     * this same file — the build's closing events land after the runtime
     * has opened, and two counters issuing the same values would corrupt
     * the order every reader sorts on.
     */
    function nextSeq(): number {
        return seq
    }

    // ── load ─────────────────────────────────────────────────────────────────

    const existing = await home.data.sessions.exists(opts.root, opts.sessionId)

    const prior = existing
        ? (await home.data.sessions.read(opts.root, opts.sessionId)) as (AxonSessionEvent | AxonKernelEvent | AxonEntry)[]
        : []

    if (existing) {
        // one file, one total order — classify each event into its read view
        // from its own type namespace, the same rule the write path uses
        for (const event of prior) {
            if (isEntryEvent(event.type)) entries.push(event as AxonEntry)
            else if (isKernelEvent(event.type)) kernelLog.push(event as AxonKernelEvent)
            else log.push(event as AxonSessionEvent)
        }

        // restore the seq high-water mark before the first commit
        seq = prior.reduce((max, e) => Math.max(max, e.time.seq + 1), 0)
    }

    /**
     * A file holding ONLY build events is not a prior conversation — it is
     * this session's own build, written before the runtime existed (see
     * BuildRecorder). Opening onto it is still an open.
     *
     * Without this distinction every first boot reported itself as a
     * resume, because the build had already created the file. The seq
     * high-water mark above is still restored either way: the build's
     * events are real entries in the same total order, and continuing from
     * them is what keeps disk order authoritative.
     */
    const resuming = prior.some(event => !isBuildEvent(event.type))

    await commit(resuming ? "axon:session:restored" : "axon:session:opened", {})

    return {
        id: opts.sessionId,
        log: log as readonly AxonSessionEvent[],
        /** internal tick/phase/system telemetry — devtools/flame-graph material, never rendered to the user. */
        kernelLog: kernelLog as readonly AxonKernelEvent[],
        /** the session's one entry log */
        entries: entries as readonly AxonEntry[],
        /** The next sequence number — see nextSeq(). */
        get seq() { return nextSeq() },
        commit,

        /** append a typed entry to the session's one log — durable, then announced on the bus */
        commitEntry,

        /**
         * The sense pathway — NOT the entry log. See Stimuli() above for
         * why this is a separate object: ingest() durably commits to the
         * entry log (the permanent record) AND queues for delivery;
         * drain() only ever touches the ephemeral delivery queue, called by
         * the scheduler alone, once per invoke.
         */
        stimuli: {
            ingest,
            drain(): AxonStimulusEntry[] {
                return stimuli.drain()
            },
        },

        /** the error sink's commit path — bounded queue, never the ordered writer */
        commitError,

        /**
         * Drain queued appends. The ordered writer is awaited fully (it only
         * ever holds real, user-caused commits); the error queue is given a
         * hard ceiling since it can grow independently of anything the user
         * did and must never be the reason shutdown hangs.
         */
        async close(): Promise<void> {
            await drainWithTimeout(writer, "session writer")
            await errorQueue.drain()
        },
    }
}

type SessionStateHandle = Awaited<ReturnType<typeof SessionState>>

// ── AxonSession ───────────────────────────────────────────────────────────────

/**
 * The agent's memory: one session per agent, swappable at runtime.
 *
 * Manager over a loaded SessionState — callers (the kernel above all) never
 * hold the inner state, so switch() can swap sessions with nobody downstream
 * knowing. Reads come from the in-memory entry cache; writes flow through
 * the single commit pipeline: durable first, bus second.
 *
 * No thread concept: one session is always exactly one continuous entry
 * log. Multiple independent conversations are multiple Axon() instances
 * (each its own session), a host-level (TUI) concern this file has no
 * opinion on.
 */
export async function AxonSession(opts: AxonSessionOpts) {
    const agentId = opts.blueprint.agent.name
    const root = path.resolve(opts.blueprint.paths.root, opts.blueprint.paths.data)

    let current = await SessionState({
        sessionId: opts.blueprint.session.id,
        agentId,
        root,
        bus: opts.bus,
    })

    return {
        get id() { return current.id },

        /** The next sequence number — a build recorder writing into the same file continues above it. */
        get seq() { return current.seq },

        /** the session lifecycle log — runtime/continuity facts */
        get log() { return current.log },

        /** internal tick/phase/system telemetry — devtools/flame-graph material, never rendered to the user */
        get kernelLog() { return current.kernelLog },

        /** the session's one entry log */
        get entries() { return current.entries },

        /** commit a session-level event (kernel telemetry, runtime facts) */
        commit<K extends keyof AxonEventMap>(type: K, data: AxonEventMap[K], ctx?: CommitContext) {
            return current.commit(type, data, ctx)
        },

        /** append a typed entry to the session's one log */
        commitEntry<K extends keyof AxonEntryEvent>(type: K, data: AxonEntryEvent[K], ctx?: CommitContext) {
            return current.commitEntry(type, data, ctx)
        },

        /**
         * The sense pathway — durable ingest (commit + delivery queue) and
         * drain (scheduler-only, ephemeral). See SessionState's own
         * `stimuli` for why this isn't the entry log.
         */
        stimuli: {
            ingest<K extends AxonStimulusType>(type: K, data: AxonStimulusEvent[K]) {
                return current.stimuli.ingest(type, data)
            },
            drain() { return current.stimuli.drain() },
        },

        /**
         * Run fn with this session as err()'s attribution scope — every
         * AxonError constructed downstream (through awaits, callbacks,
         * nested calls) lands as this session's own canonical "axon:error" event.
         * Established ONLY at the runtime's well-defined entry points
         * (Axon() construction, each kernel wake, reload) — never littered
         * through leaf code; err() itself stays context-free. Reads
         * `current` at delivery time, so a switch() mid-flight re-points
         * attribution without re-wrapping.
         */
        scope<T>(fn: () => T): T {
            return errScope.run(error => current.commitError({ error }), fn)
        },

        /**
         * Explicit failure boundary for errors created in an isolated cognet
         * bundle (which carries its own @axon/err sink). The kernel reports
         * the caught failure into the owning session instead of assuming the
         * throw site's package copy could reach this runtime's scope.
         */
        reportError(error: AxonEventMap["axon:error"]["error"]): void {
            current.commitError({ error })
        },

        /** swap to a different session: load next fully, go live, drain the old writer */
        async switch(sessionId: string) {
            const next = await SessionState({ sessionId, agentId, root, bus: opts.bus })
            const previous = current
            current = next
            await previous.close()
        },

        /** record axon:session:closed and guarantee everything is on disk */
        async end() {
            await current.commit("axon:session:closed", {})
            await current.close()
        },
    }
}

export type AxonSessionT = Awaited<ReturnType<typeof AxonSession>>
