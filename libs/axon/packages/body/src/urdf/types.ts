import type { body } from "@arcforge/types"

/**
 * A body's skeleton, as URDF describes one: its frames; from a
 * `<ros2_control>` block, the joints it drives and reads; from Gazebo's
 * `<sensor>`s, what else it senses; and how it stands in its world — fixed
 * to it, or free, and the places its senses read in.
 */
export type Skeleton = {
    name: string
    frames: body.Frame[]
    controls: body.Control[]
    senses: body.Sense[]
    anchored: boolean
    places: body.Place[]
}

/** One parsed XML element: its attributes and children by name. */
export type Element = Record<string, any>
