import type { ComponentType } from "./types"
import type { EcsEmit } from "./ecs"

/**
 * A space beliefs can be positioned in — and the reason two of them compose.
 *
 * Deliberately not restricted to metric space: a dependency graph, a file tree
 * and a conversation are all spaces with positions and neighbours. A mind with
 * no body lays its beliefs out the same way a robot does, which is what keeps
 * this usable for agents that never see anything.
 */
export type FrameDescriptor = {
    kind: "metric2d" | "metric3d" | "graph" | "tree" | "sequence"
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
    relativeTo?: string
    /** Where the parent's origin sits in THIS frame's axes. */
    origin?: number[]
    /** Parent units per unit of this frame — 4 when this frame is a quarter-scale image. */
    scale?: number
}

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
    /**
     * The declared frame this value lives in, BY NAME. Absent means the belief
     * makes no positional claim.
     *
     * A name rather than a fixed list of spatial words: an agent may hold eight
     * cameras, a joint space and a call graph at once, and no enum describes
     * all three.
     */
    frame?: string
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
 * Declaring is idempotent: re-declaring the same type is a no-op, so a system
 * may declare its own components on every construction without the log filling
 * with restatements. Re-declaring a type DIFFERENTLY throws — a component that
 * changes shape underneath a reader is a bug, not a migration.
 */
export function Schema(opts: SchemaOpts) {
    const declared = new Map<ComponentType, ComponentDescriptor>()
    const frames = new Map<string, FrameDescriptor>()

    return {
        /**
         * Declares a space beliefs can be positioned in. Idempotent, and a
         * conflicting redeclaration throws for the same reason components do:
         * a frame that changes shape invalidates every belief drawn in it.
         */
        frame(name: string, descriptor: FrameDescriptor): void {
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

        /** Every declared frame, for readers that lay beliefs out by space. */
        frames(): Array<{ frame: string; descriptor: FrameDescriptor }> {
            return [...frames].map(([frame, descriptor]) => ({ frame: frame, descriptor: descriptor }))
        },

        declare(type: ComponentType, descriptor: ComponentDescriptor): void {
            const existing = declared.get(type)
            if (existing) {
                if (JSON.stringify(existing) === JSON.stringify(descriptor)) return
                throw new Error(
                    `component "${type}" is already declared with a different shape — ` +
                    `a component cannot change shape while readers are rendering it`,
                )
            }

            declared.set(type, descriptor)
            void opts.emit("cognet:component:declare", { component: type, ...descriptor })
        },

        /** The descriptor, or undefined for a component nothing has described. */
        get(type: ComponentType): ComponentDescriptor | undefined {
            return declared.get(type)
        },

        /** Every declared component type, for readers that render the whole schema. */
        all(): Array<{ component: ComponentType; descriptor: ComponentDescriptor }> {
            return [...declared].map(([component, descriptor]) => ({
                component: component,
                descriptor: descriptor,
            }))
        },
    }
}

export type SchemaT = ReturnType<typeof Schema>
