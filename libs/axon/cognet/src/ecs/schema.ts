import type { Component, Frame } from "./handle"
import type { EcsEmit } from "./ecs"
import type { Archetype, FrameKind, InstrumentRole } from "@arcforge/types"

/**
 * A space beliefs can be positioned in — and the reason two of them compose.
 *
 * Deliberately not restricted to metric space: a dependency graph, a file tree
 * and a conversation are all spaces with positions and neighbours. A mind with
 * no body lays its beliefs out the same way a robot does, which is what keeps
 * this usable for agents that never see anything.
 */
export type FrameDescriptor = {
    kind: FrameKind
    /** Physical unit of the axes, for metric frames. */
    unit?: string
    /** Size along each axis, so a reader scales without waiting for outliers. */
    extent?: number[]
    /**
     * The frame this one is expressed relative to, if any — a camera frame
     * relative to the body, a body frame relative to a map.
     *
     * With `origin` and `scale` it says how to convert between the two, which
     * is what lets a reader draw a belief held in ANOTHER frame here: a thing
     * positioned in the body frame becomes a box on the camera image, and the
     * same belief becomes a dot on a map, with no reader knowing what either
     * frame means. Declared by the mind because only the mind knows.
     */
    relativeTo?: Frame
    /** Where the parent's origin sits in THIS frame's axes. */
    origin?: number[]
    /** Parent units per unit of this frame — 4 when this frame is a quarter-scale image. */
    scale?: number
    /**
     * Which way is up in this frame, as a direction along its axes —
     * `[0, 1, 0]` for a world whose y rises, `[0, 0, 1]` for one whose z
     * does. Only a viewer reads it: it decides which way a 3D view stands
     * the frame. Absent: z for a 3D frame; −y for a 2D one, which a 2D view
     * draws y growing down, as a picture is.
     */
    up?: number[]
    /**
     * The sense whose space this frame IS — the pixels of `"/vision"`, the
     * axes of an inner ear's `"/body"`. Declared by the mind, so a viewer
     * knows outright where that sense's readings — and anything said about
     * them, like a lab's answer for where the body truly was — belong: every
     * belief positioned in a frame connected to a camera lands on its picture.
     */
    sensor?: string
}

/**
 * How a viewer DRAWS a component in space — the contract a debugger renders
 * against. A fixed vocabulary, so any mind's beliefs appear in any viewer
 * without the viewer knowing what they mean.
 *
 * Each names the value's shape (one of it, an array of it, or a record
 * holding one array of it — a set of proposals written as one component).
 * The mind says WHAT and WHERE; how it looks is the viewer's choice.
 *
 *   point      { x, y, z?, spread?, radius?, label? }
 *                                                a located thing; spread is its doubt, radius
 *                                                the circle it covers (a focus) — either is a ring
 *   box        { x, y, z?, width, height, depth?, label?, score? }
 *                                                a located thing with size — x/y/z the CENTRE;
 *                                                score 0..1 is how sure, drawn as strength
 *   arrow      { x, y, z?, dx, dy, dz? }         a direction or velocity from a point
 *   path       { points: [x, y, z?][] }          a route, an outline
 *
 *   Every placed archetype is three-dimensional: one that says no z (no
 *   depth, no dz) lies in its frame's own plane, at zero — which is what a 2D
 *   frame's beliefs are. A 2D view draws x and y; a 3D view draws all three.
 *   grid       { cols, rows, values, shape?, range?, labels?, bounds?, of?, confidence? }
 *                                                a field over the frame, row-major:
 *                                                  shape  scalar (default) — a heat map
 *                                                         vector2 — two numbers a cell, a flow
 *                                                         categorical — class per cell, `labels` names them
 *                                                         rgb — three 0..1 numbers a cell, a colour view
 *                                                         painted as it is (what a learned encoder tells apart)
 *                                                  bounds { x, y, width, height } the rectangle it
 *                                                         covers; absent, the frame's extent
 *                                                  of     { channel, seq } the sensation it was
 *                                                         computed from, so it lines up with that picture
 *                                                  confidence  0..1 a cell, how far its value can
 *                                                         be believed — 0 is "not measured", which a
 *                                                         viewer must not draw as a measured zero
 *   cloud      { points: number[], colours?: number[] }
 *                                                many points at once — `points` flat x, y, z, x, y, z…;
 *                                                `colours` flat red, green, blue (0..255) a point. A map
 *                                                built in three dimensions, a depth camera's look
 *   raster     { uri, x, y, width, height }      a picture placed in the frame — x/y its TOP-LEFT,
 *                                                width/height what it covers in frame units; uri an
 *                                                encoded image (data: or http). A map's tiles, a crop.
 *   view       { width, height, lens, distance, of }
 *                                                what a camera saw, held in the camera's own frame
 *                                                (x right, y down, z ahead): the picture `of`
 *                                                { channel, seq }, width × height px, stood up
 *                                                `distance` ahead through `lens` — { kind:
 *                                                "perspective", fov } (vertical, degrees; the
 *                                                picture's middle straight ahead) or { kind:
 *                                                "orthographic", scale } (units a px; top-left at
 *                                                the origin). Drawn as the camera, where it looked,
 *                                                and what it saw there
 *   series     number, or a record of numbers    plotted over time, not placed
 *   transform  { relativeTo, at: [x,y,z], turn: [x,y,z,w] }
 *              — held on the entity NAMED for a frame: where that frame sits in
 *              its parent. What connects one space to another.
 *   span       { from: { seq, at }, to: { seq, at } }
 *              — a stretch of the session's text, in a `sequence` frame: each
 *              end an entry and an offset into `entryText(entry)`, UTF-16, `to`
 *              exclusive. The ends may lie in different entries (a topic);
 *              equal ends are a boundary. Text perception's position: an atom,
 *              a mention, a segment; the entity's other components colour it
 */
export type { Archetype }

/** What a component type is, told once so every write afterwards is just data. */
export type ComponentDescriptor = {
    /**
     * What the value is INDEXED BY — the property that decides layout.
     *
     * A mood and a depth map are both scalars; one is a scalar at a point and
     * the other a scalar over an image. Shape alone cannot tell them apart,
     * which is why a reader given only shape cannot lay a mind out.
     *
     * `sequence` and `tree` are deliberately separate even though a tree
     * subsumes a list. In a sequence, order is ORDER — do this, then that. In a
     * tree, depth is REASON — this is why that. A goal decomposition rendered
     * as a flat list loses the only thing it was carrying.
     */
    domain: "point" | "space" | "time" | "sequence" | "tree" | "set"
    shape: "scalar" | "vector" | "categorical" | "record"
    unit?: string
    range?: [number, number]
    labels?: string[]
    options?: string[]
    /** Physical meaning for a cockpit instrument. See InstrumentRole. */
    instrument?: InstrumentRole
    /**
     * The frame this value lives in. Absent means the belief makes no
     * positional claim.
     *
     * A handle rather than a fixed list of spatial words: an agent may hold
     * eight cameras, a joint space and a call graph at once, and no enum
     * describes all three. A handle rather than a name, so a component cannot
     * point at a frame nobody declared.
     */
    frame?: Frame
    /**
     * How a viewer draws it, in `frame`. Absent: shown as a value, not drawn.
     * See `Archetype`.
     */
    archetype?: Archetype
    /**
     * Whether this belief belongs to the WORKSPACE — the pool a mind's
     * attention may draw from.
     *
     * A property of the KIND of belief, not of an instance: "fear is the sort
     * of thing a mind should be able to see; an efference copy is not."
     * Choosing between a hundred instances is attention's job, and attention
     * selects from this pool rather than defining it.
     *
     * Declared here rather than inferred from whatever an attention system
     * happens to query, because that would put the boundary in code: add a new
     * belief, forget to update attention, and it silently never reaches
     * cognition. Stating it at the moment the belief is defined is the moment
     * the answer is actually known.
     */
    workspace?: boolean
}

/** A component's descriptor as readers receive it: its frame by name. */
export type DeclaredComponent = Omit<ComponentDescriptor, "frame"> & { frame?: string }

/** A frame's descriptor as readers receive it: its parent by name. */
export type DeclaredFrame = Omit<FrameDescriptor, "relativeTo"> & { relativeTo?: string }

export type SchemaOpts = {
    emit: EcsEmit
}

/**
 * Schema — what each component type IS, declared once per world.
 *
 * A write says "Fear is now 0.62". Only a declaration says Fear is a scalar in
 * 0..1, or that a position is measured from a remembered anchor rather than
 * the world origin. Without that, a reader has the mind's data and no way to
 * draw it honestly — and repeating the description on every write would put
 * that metadata in the highest-volume event family twenty times a second.
 *
 * Declared from each frame handle and each component handle's `display`, once,
 * by the schedule on its first run. Idempotent; re-declaring DIFFERENTLY throws — a component that
 * changes shape underneath a reader is a bug, not a migration.
 */
export function Schema(opts: SchemaOpts) {
    const declared = new Map<string, DeclaredComponent>()
    const frames = new Map<string, DeclaredFrame>()

    const schema = {
        /**
         * Declare a frame to readers, its parent first. Idempotent, and a
         * conflicting redeclaration throws for the same reason components do:
         * a frame that changes shape invalidates every belief drawn in it.
         */
        frame(frame: Frame): void {
            const { relativeTo, ...rest } = frame.opts
            if (relativeTo) schema.frame(relativeTo)
            const descriptor: DeclaredFrame = relativeTo ? { ...rest, relativeTo: relativeTo.name } : rest
            const name = frame.name

            const existing = frames.get(name)
            if (existing) {
                if (JSON.stringify(existing) === JSON.stringify(descriptor)) return
                throw new Error(
                    `frame "${name}" is already declared with a different kind — ` +
                    `every belief positioned in it would move`,
                )
            }

            frames.set(name, descriptor)
            void opts.emit("cognet:frame:declare", { frame: name, ...descriptor })
        },

        /**
         * Declare a component to readers, from its handle's `display`.
         * A component with no display is known to the schedule but has
         * nothing to tell a renderer, so nothing is emitted for it.
         */
        declare(component: Component<any>): void {
            const display = component.opts.display
            if (!display) return
            const { frame, ...rest } = display
            const descriptor: DeclaredComponent = frame ? { ...rest, frame: frame.name } : rest
            const name = component.name

            if (descriptor.instrument) {
                const allowed: readonly InstrumentRole[] = ["velocity", "acceleration", "angular-velocity", "altitude", "joint-position", "joint-effort", "power", "temperature"]
                const vector = descriptor.instrument === "velocity" || descriptor.instrument === "acceleration" || descriptor.instrument === "angular-velocity"
                const limited = descriptor.instrument === "joint-position" || descriptor.instrument === "joint-effort"
                const range = descriptor.range
                if (!allowed.includes(descriptor.instrument) || descriptor.domain !== "point" || descriptor.shape !== (vector ? "vector" : "scalar") || !descriptor.unit || (vector && (!descriptor.frame || ![2, 3].includes(descriptor.labels?.length ?? 0))) || (limited && !range) || (range && (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] >= range[1]))) {
                    throw new Error(`component "${name}" declares ${descriptor.instrument} without its required shape, unit, frame or limits`)
                }
            }

            const existing = declared.get(name)
            if (existing) {
                if (JSON.stringify(existing) === JSON.stringify(descriptor)) return
                throw new Error(
                    `component "${name}" is already declared with a different shape — ` +
                    `a component cannot change shape while readers are rendering it`,
                )
            }

            declared.set(name, descriptor)
            void opts.emit("cognet:component:declare", { component: name, ...descriptor })
        },

        /** The descriptor, or undefined for a component with no display. */
        get(name: string): DeclaredComponent | undefined {
            return declared.get(name)
        },

        /** Every described component, for readers that render the whole schema. */
        all(): Array<{ component: string; descriptor: DeclaredComponent }> {
            return [...declared].map(([component, descriptor]) => ({
                component: component,
                descriptor: descriptor,
            }))
        },
    }

    return schema
}

export type SchemaT = ReturnType<typeof Schema>
