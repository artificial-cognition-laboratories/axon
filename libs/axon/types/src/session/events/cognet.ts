import type { StimulusRef } from "./stdio/shared"
import type { AxonError } from "../../error"
import type { AxonLogEvents } from "./log"
import type { AxonCancellableSpan, AxonSpan } from "./span"

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
        { tick: number },
        { tick: number },
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
    & AxonCancellableSpan<
        "cognet:system",
        { tick: number; phase: string | null; system: string },
        { tick: number; phase: string | null; system: string },
        { tick: number; phase: string | null; system: string; error: AxonError },
        { tick: number; phase: string | null; system: string }
    >
    & {
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
        /** Expected bounds, so a reader can scale without waiting for outliers. */
        range?: [number, number]
        /** Component names, in value order. Vectors only. */
        labels?: string[]
        /** The permitted values. Categoricals only. */
        options?: string[]
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
        kind: "metric2d" | "metric3d" | "graph" | "tree" | "sequence"
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
    }

    // ── Probes ───────────────────────────────────────────────────────────────
    //
    // A map the mind computed and would like looked at: a motion field, a
    // depth estimate, an attention map, the error of a prediction.
    //
    // NOT a belief, and deliberately not a component: it is per-pixel, arrives
    // at the rate of the sense it came from, and nothing in the mind reads it.
    // Retained like a sensation (bounded, evicted, never in the permanent log)
    // for exactly the reason a frame is — a megabyte a second of instrument
    // output would drown the record it is meant to explain.
    //
    // `frame` positions it, and `source` names the sensation it was computed
    // from, so a reader scrubbed back to one moment lays the map over the
    // exact frame it describes rather than the newest one.
    "cognet:probe:raster": {
        /** Where this probe publishes, e.g. "/probe/features". One channel is one layer. */
        channel: string
        ref: StimulusRef
        /** The declared frame its pixels are positioned in. */
        frame: string
        /** The sensation it explains: that channel, and that entry's seq. */
        source?: { channel: string; seq: number }
        width: number
        height: number
        /** What the channels mean, e.g. ["motion", "", "screen-fixed"]. Read as a legend. */
        legend?: string[]
    }

    // A MEASUREMENT on a grid — the honest form of an instrument, and what
    // `probe:raster` should be used for only when the answer really is an image.
    //
    // A raster forces the mind to pre-colour its own data, and that costs three
    // things a reader cannot get back: the VALUES (0.37 is unrecoverable from a
    // red pixel), the SEPARATION (three unrelated questions packed into three
    // channels composite into colours nobody can decode), and the COLOURMAP
    // decision, which belongs to whoever is looking rather than to cognition.
    //
    // So a field carries numbers and says what they mean, in the same vocabulary
    // the component schema already uses — `shape`, `range`, `options`, `unit`.
    // One description system, so anything that can draw a belief can draw a
    // probe: the reader picks a scale, shows a real key, and can report the
    // value under the cursor.
    //
    // ONE CHANNEL IS ONE QUESTION. `/probe/independent` and `/probe/band` are
    // two fields, never one image with two channels — that is the whole point.
    //
    // Coarse by construction. A field is meant to be scaled, inspected and
    // reasoned about, so `values` is plain numbers and the grid is expected to
    // be at most a few thousand cells. Per-pixel output stays a raster, where
    // the image encoding is what makes it affordable.
    "cognet:probe:field": {
        /** Where this field publishes, e.g. "/probe/independent". */
        channel: string
        /** The declared frame its cells are positioned in, so a reader can place them. */
        frame: string
        /** The sensation it explains: that channel, and that entry's seq. */
        source?: { channel: string; seq: number }
        /** The grid, row-major. Cells are stretched across the frame's extent. */
        cols: number
        rows: number
        /**
         * What one cell is.
         *
         * `scalar` — one number per cell, coloured by `range`.
         * `categorical` — an index into `options`, coloured by identity.
         * `vector2` — two numbers per cell, drawn as direction and magnitude.
         */
        shape: "scalar" | "categorical" | "vector2"
        /**
         * A scalar's value range, so a reader scales immediately rather than
         * waiting for outliers — and so a range spanning zero is recognisably
         * signed and gets a diverging scale.
         */
        range?: [number, number]
        /** A categorical's values, in index order. `values[i]` selects one. */
        options?: string[]
        /** A vector2's two components, e.g. ["dx", "dy"]. */
        labels?: string[]
        unit?: string
        /**
         * How it composites over the picture.
         *
         * `add` is light the eye found in the image — motion energy, salience.
         * `over` is a judgement ABOUT the image — a classification, a depth
         * band — and adding those together produces colours that mean nothing.
         * Declared because only the mind knows which it made.
         */
        blend?: "add" | "over"
        /** One sentence: what this field is, for whoever is looking at it. */
        meaning?: string
        /** Row-major. One number per cell, or two for `vector2`. */
        values: number[]
    }

    // ── Schedule ─────────────────────────────────────────────────────────────
    //
    // The shape of the mind: every system, when it runs, and which beliefs it
    // reads and writes. An ECS has no call graph — systems never call each
    // other — so this data lineage IS the program's structure, and without it
    // a reader can see beliefs change but never what connects them.
    //
    // Declared once, on the schedule's first run, like the world schema. It is
    // a claim, not a measurement: the writes each system actually makes arrive
    // stamped with its name, and a reader comparing the two is how an
    // undeclared write is caught.
    "cognet:schedule:declare": {
        systems: Array<{
            name: string
            phase: string
            /** Private rate. 0 = every tick. */
            everyMs: number
            reads: string[]
            writes: string[]
        }>
    }

    // What one system run actually READ: every value, by the rev it was at.
    //
    // The declared `reads` say what a system may look at; this says what it
    // did look at, this tick. It makes every write in the same run a child of
    // exactly these values, which is what lets a reader answer "why is this
    // 0.62?" as a chain of real values rather than a guess from declarations.
    "cognet:system:reads": {
        tick: number
        phase: string | null
        system: string
        reads: Array<{ entity: string; component: string; rev: number }>
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
