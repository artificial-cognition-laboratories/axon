import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"
import type { AxonCancellableSpan, AxonSpan } from "./span"

/** Instrument meaning is declared by the producer; a viewer never infers it from a component name or number count. */
export type InstrumentRole = "velocity" | "acceleration" | "angular-velocity" | "altitude" | "joint-position" | "joint-effort" | "power" | "temperature"

/**
 * What a tick opened with. A mind with systems has its ticks run by its
 * schedule, which says what each one answered — enough to run it again
 * exactly as it ran. A tick of a `loop()` mind carries only its number.
 */
export type CognetTickStart = {
    tick: number
    /** The moment the tick stands for — every system's `now` in it. */
    now?: number
    /**
     * How many wakes the tick answers. More than one when wakes arrived
     * while the tick before it ran: they merge into the one tick waiting.
     */
    wakes?: number
    /**
     * The stimuli it admitted — every one that arrived since the tick before
     * it — by their place in the mind's own stream: from its `from`th
     * stimulus (counting from 0), `count` of them. Not by seq: a confined
     * agent's events are stamped again by the supervisor that records them,
     * so the seqs a mind saw are not the log's. Absent: none arrived.
     */
    admitted?: { from: number; count: number }
}

/** How a tick ended. */
export type CognetTickComplete = {
    tick: number
    /**
     * The time the tick spent waiting on a system rather than running one,
     * by system, ms: a worker its next system needed, or a lagged run landing
     * late. What set the tick's length when it ran over.
     */
    held?: Array<{ system: string; ms: number }>
}

/**
 * Cognet telemetry — the cognition artifact's own observability record.
 *
 * Semantically distinct from kernel:* and enforced at the seam: this map is
 * the ONLY vocabulary abi.emit accepts, so a cognet can narrate its world
 * (ticks, phases, systems, entity/component writes) but can never forge
 * kernel machinery events (run records, engine calls).
 *
 * Fire-and-forget for the cognet, durable in the machine: abi.emit commits
 * these to the session's log (telemetry view, alongside kernel:*) and the
 * commit pipeline forwards them to the bus — flame-graph and devtools
 * material, never rendered to the user. At some level cognet events have
 * to reach a log for the brain to be debuggable; this is that level. The
 * durable record around a wake (kernel:run:*) remains the kernel's and
 * only the kernel's.
 *
 * The world clock lives HERE, not in kernel:* — since cognition moved into
 * the cognet layer, ticks and phases are the program's own clock; the
 * kernel neither knows nor cares that a program ticks.
 */
export type CognetEventMap =
    & AxonLogEvents<"cognet">
    // ── Artifact lifecycle ───────────────────────────────────────────────────
    //
    // Emitted by the KERNEL, not by the cognet — deliberately the one family
    // in this map the brain does not produce. exec'ing an untrusted artifact
    // is the most failure-prone step in boot, and a cognet that dies inside
    // load() cannot narrate its own failure: whatever bracket it opened would
    // never close. The kernel is the only loader (see Kernel()), so it is the
    // only thing positioned to record both halves honestly.
    & AxonSpan<"cognet:load", { name: string }, { name: string }, { name: string; error: AxonError }>
    & AxonSpan<"cognet:unload", { name: string }, { name: string }, { name: string; error: AxonError }>
    // ── World clock ──────────────────────────────────────────────────────────
    //
    // Three nested levels, each the four-state form: a tick contains phases,
    // a phase contains systems. :interrupted at every level means the wake
    // was cancelled (Escape/Ctrl+C, engine abort) — cancellation, not a bug,
    // kept distinct from :failed so devtools never conflate the two.
    //
    // The bracket identity is in the payload (tick number, phase name,
    // system name), which is what lets a reader pair a start with its own
    // end when siblings of the same stem appear in one run.
    & AxonCancellableSpan<
        "cognet:tick",
        CognetTickStart,
        CognetTickComplete,
        { tick: number; error: AxonError },
        { tick: number }
    >
    & AxonCancellableSpan<
        "cognet:phase",
        { tick: number; phase: string },
        { tick: number; phase: string },
        { tick: number; phase: string; error: AxonError },
        { tick: number; phase: string }
    >
    & {
    // ── One system run, whole ────────────────────────────────────────────────
    //
    // ONE record per run, emitted when it ends — not a start/reads/complete
    // triad. Systems run tens of times a tick, and the triad was three events
    // per run: 77% of every event a continuous mind logged, measured on Terry
    // at 20Hz, and most of what its log, its link and its debugger carried.
    // A run's start is a field (`at`), so a reader still draws it as a span.
    //
    // `durationMs` is the run's OWN time. For an async system that is the
    // time it computed beside the tick, not the moment its writes landed —
    // which is what the triad used to report, and why async systems looked
    // free.
    "cognet:system:run": {
        tick: number
        phase: string | null
        system: string
        /** When the run began, epoch ms. */
        at: number
        durationMs: number
        outcome: "complete" | "failed" | "interrupted"
        error?: AxonError
        /** It ran beside the tick; its writes landed at `tick`. */
        async?: true
        /** The worker thread it ran on, from 0. Absent: the main thread. */
        thread?: number
        /** It started this many ticks before `tick`, the one its writes landed in (see `lag` on the system). */
        lag?: number
        /**
         * What the run actually read — every value, by the rev it was at. The
         * declared `reads` say what a system may look at; this says what it
         * did look at, which makes every write in the run a child of exactly
         * these values — "why is this 0.62?" answered as a chain of real
         * values, not a guess from declarations. Absent when the runtime could
         * not observe it (an async run).
         */
        reads?: Array<{ entity: string; component: string; rev: number }>
        /** Query calls in run order: final matches by revision, without duplicating values. */
        queries?: Array<{ ordinal: number; required: string[]; optional: string[]; where?: unknown; filtered: boolean; candidates: number; count: number; matched: Array<{ entity: string; values: Array<{ entity: string; component: string; rev: number }> }> }>
        /**
         * The stimuli this run consumed, by their own seq in this log — where
         * a chain of causes leaves the mind. Absent for a run that declares no
         * input.
         */
        inputs?: Array<{ seq: number; channel: string }>
    }

    // ── Knowledge mutations ──────────────────────────────────────────────────
    //
    // Emitted by the KERNEL when a cognet writes or removes long-term
    // knowledge — the cognet never records its own mutations, the same rule
    // that governs run()'s action/result pair.
    //
    // Not a span: a write is a settled act, not a bracket. There is no
    // meaningful "in progress" for an atomic temp+rename, so :start/:complete
    // would be two lines describing one instant.
    //
    // Traced because "the agent modified its own long-term memory" is exactly
    // the fact you want when behaviour drifts weeks later. Name only, never
    // content — the log records that memory changed, not a second copy of it.
    /**
     * A worker thread answered its first job: which OS thread it is. Lets a
     * reader of per-thread CPU (axon:usage `threads`) name worker N instead
     * of guessing from thread names. `tid` is null where the OS has no
     * per-thread ids to give.
     */
    "cognet:thread:start": { index: number; pid: number; tid: number | null }
    /**
     * A lagged run was still going when the tick it lands in came, and the
     * tick waited `waitedMs` for it — its work is longer than its lag. The
     * mind's result is unchanged (it lands where it always would); only the
     * tick was late.
     */
    "cognet:system:overrun": { tick: number; system: string; lag: number; waitedMs: number }
    /**
     * What the mind is working on, beside its ticks: the async systems with a
     * run in flight, by name. Emitted when that set changes — a run starting,
     * or the last one landing — so a client can show a mind as busy without
     * asking it anything. Empty: nothing is in flight.
     */
    "cognet:activity": { working: string[] }
    /**
     * Stimuli the mind is done with, by the seq it received each at: every
     * system that reads stimuli has taken them, and every run that took them —
     * and whatever that run started — has ended. Whatever the mind was going
     * to do about them, it has done. What ends a request to a continuous mind.
     */
    "cognet:settled": { seqs: number[] }
    "cognet:knowledge:write": { name: string }
    "cognet:knowledge:remove": { name: string }

    // ── World schema ─────────────────────────────────────────────────────────
    //
    // A component type describes itself ONCE, when the world first sees it.
    //
    // The alternative — shape metadata on every write — repeats "Fear is a
    // scalar in 0..1" twenty times a second in the highest-volume family in
    // the system. Declaring once also means a reader can render a component
    // before any value has arrived, so panes exist from world spawn rather
    // than appearing on first write.
    //
    // `frame` is not decoration. A position or field is meaningless without
    // knowing whether it is measured from the body, from a remembered anchor,
    // or in world coordinates, and a reader that guesses draws a convincing
    // lie. Components carrying no spatial claim declare "none".
    "cognet:component:declare": {
        component: string
        /**
         * What the value is INDEXED BY — the thing that decides how a reader
         * lays it out. A mood and a depth map are both scalars; one is a
         * scalar at a point and the other a scalar over an image, and only
         * the domain distinguishes them.
         */
        domain: "point" | "space" | "time" | "sequence" | "tree" | "set"
        /** What sits at one index. */
        shape: "scalar" | "vector" | "categorical" | "record"
        /** Physical unit for scalar/vector readings — "hp", "px/tick", "bool". */
        unit?: string
        /** Optional physical meaning for cockpit instruments. Requires the matching shape, unit and frame/limits. */
        instrument?: InstrumentRole
        /** Expected bounds, so a reader can scale without waiting for outliers. */
        range?: [number, number]
        /** Component names, in value order. Vectors only. */
        labels?: string[]
        /** The permitted values. Categoricals only. */
        options?: string[]
        /** How a viewer draws it in its frame — see `Archetype`. Absent: shown as a value, not drawn. */
        archetype?: Archetype
        /**
         * The declared frame this value is expressed in, by name.
         *
         * A NAME rather than an enum: an agent may hold eight cameras, a
         * joint space, and a dependency graph, and a fixed list of spatial
         * words cannot describe any of them. Absent means the belief makes no
         * positional claim at all. See cognet:frame:declare.
         */
        frame?: string
        /**
         * Whether this belief is in the WORKSPACE — the pool a mind's attention
         * may draw from, as opposed to the machinery it runs on.
         *
         * A reader can therefore show what a mind could in principle attend to,
         * separately from everything it merely stores.
         */
        workspace?: boolean
    }

    // ── World writes ─────────────────────────────────────────────────────────
    //
    // `value` carries the data itself, which is what makes the world
    // reconstructible from the log rather than merely auditable. Without it
    // these events say a component changed but never to what, so no reader
    // can render the mind's contents and no replay can rebuild them.
    //
    // The volume this implies is governed at the WRITE — Component() emits an
    // update only when the value actually changed. That keeps the log a record
    // of change rather than a stream of identical snapshots, and it is the
    // reason this family can afford to carry data at all.
    //
    // OPTIONAL, deliberately. A cognet is a prebuilt bundle carrying its own
    // inlined host, so bundles compiled before this field existed are still
    // running and still emitting these events without it. Declaring it required
    // would make the type a lie about the wire AND force an ABI bump, which
    // refuses every already-published cognet for a field no reader needs in
    // order to function. A reader that has no value renders nothing for that
    // belief, which is the correct outcome.
    // ── Frames ───────────────────────────────────────────────────────────────
    //
    // A frame is a space beliefs can be positioned in, and the reason two of
    // them can be layered: depth over a camera image, danger over a world map,
    // coverage over a call graph.
    //
    // Deliberately NOT restricted to metric space. A dependency graph, a file
    // tree and a conversation are all spaces with positions and neighbours, so
    // a mind with no physical body still composes its beliefs the same way —
    // which is what keeps this contract honest for agents that never see
    // anything.
    "cognet:frame:declare": {
        frame: string
        kind: FrameKind
        /** Physical unit of the axes, for metric frames. */
        unit?: string
        /** Size along each axis, so a reader can scale without waiting for outliers. */
        extent?: number[]
        /**
         * The frame this one is expressed relative to, with how to convert:
         * where the parent's origin sits in these axes, and how many parent
         * units one of these is. A camera frame related to the body frame is
         * what lets a reader draw a belief positioned in one INSIDE the other
         * — the same belief as a box on an image and a dot on a map — without
         * knowing what either frame means.
         */
        relativeTo?: string
        origin?: number[]
        scale?: number
        /** Which way is up along these axes (`[0, 1, 0]` when y rises), so a 3D viewer stands the frame upright. Absent: z for a 3D frame, −y for a 2D one (drawn y down, as a picture). */
        up?: number[]
        /** The sense whose pixels this frame is (`"/vision"`), so a viewer of that camera knows its frame. */
        sensor?: string
    }

    // ── Schedule ─────────────────────────────────────────────────────────────
    //
    // The shape of the mind: every system, when it runs, and which beliefs it
    // reads and writes. An ECS has no call graph — systems never call each
    // other — so this data lineage IS the program's structure, and without it
    // a reader can see beliefs change but never what connects them.
    //
    // Declared once, on the schedule's first run. The schedule enforces it:
    // a system that touches a component it did not declare fails its run.
    "cognet:schedule:declare": {
        /** The process the schedule runs in — whose main thread is the thread with this id. Absent from older runtimes. */
        pid?: number
        /** Continuous clock rate. Null for reactive minds; absent from older runtimes. */
        hz?: number | null
        /** Every system, in the order the schedule runs them — derived from reads and writes. */
        systems: Array<{
            /** The system's path under the cognet, without `.system.ts`. */
            name: string
            /**
             * What runs it, when it names it (\`on\`): components, or \`clock\` —
             * every tick. Null: what it reads runs it. Absent from runtimes
             * that paced systems by a declared rate.
             */
            on?: string[] | null
            /** Runs on the first tick only. */
            once: boolean
            /** Runs beside the tick: its writes land at the start of a later one. */
            async: boolean
            /** Runs on a worker thread when the cognet has threads. */
            worker: boolean
            /** Ticks from when a run starts to when its writes land; 0, the tick it ran in. Absent from older runtimes. */
            lag?: number
            /** This tick's values — every writer runs first. */
            reads: string[]
            /** Every value written since it last ran — every writer runs first. Absent from older runtimes. */
            streams?: string[]
            /** Last tick's values — no ordering edge. */
            recalls: string[]
            writes: string[]
            /** The services it calls, by the names the cognet gave them. Absent from older runtimes. */
            uses?: string[]
        }>
        /** Every component a system names, and the folder it is declared in. */
        components: Array<{ name: string; scope: string }>
        /** Every query a system names, and the components it is made of. */
        queries: Array<{ name: string; scope: string; members: string[] }>
    }

    // `system` is who made the write — null outside any system bracket (boot
    // spawning, a loop body writing directly). Optional on the wire for the
    // same reason `value` is: bundles predating it still emit these events.
    "cognet:entity:add": { tick: number; phase: string | null; system?: string | null; entity: string }
    "cognet:entity:remove": { tick: number; phase: string | null; system?: string | null; entity: string }

    //
    // `rev` names this change, world-monotonic, so a read can point at exactly
    // the value it saw. Optional on the wire for the same reason as the rest.
    "cognet:component:add": { tick: number; phase: string | null; system?: string | null; entity: string; component: string; rev?: number; value?: unknown }
    "cognet:component:update": { tick: number; phase: string | null; system?: string | null; entity: string; component: string; rev?: number; value?: unknown }
    "cognet:component:remove": { tick: number; phase: string | null; system?: string | null; entity: string; component: string }
}

/**
 * What kind of space a frame is. Not only metric: a dependency graph, a file
 * tree and a conversation are spaces too, with positions and neighbours.
 */
export type FrameKind = "metric2d" | "metric3d" | "graph" | "tree" | "sequence"

/**
 * How a component's value is drawn in its frame — the contract between a
 * mind and every viewer of it, so a viewer draws a belief without knowing
 * what it means. Each value shape is documented where a mind declares it
 * (`@arcforge/cognet`'s component schema).
 *
 *   span   { from: { seq, at }, to: { seq, at } } — a stretch of the session's text (`TextSpan`),
 *          in a `sequence` frame. Text perception's position: an atom, a
 *          mention, a segment. The entity's other components colour it.
 */
export type Archetype = "point" | "box" | "arrow" | "path" | "cloud" | "grid" | "raster" | "view" | "series" | "transform" | "span"
