import type { Picture } from "./media"

/**
 * Which parts of a picture are nearer, and which farther — with no unit. A
 * larger value is nearer. Ordering within one answer is all it claims: the
 * scale of one says nothing about the scale of the next.
 */
export interface DepthRelative {
    describe(): {
        /** The longest side it estimates at; a larger picture is answered at this, and scaled. */
        maxSide: u32
    }

    /** Nearness for every cell of a grid over the whole picture. */
    estimate(picture: Picture): Promise<Nearness>
}

/** `width × height` cells covering the whole picture, row by row from the top; larger is nearer. */
export interface Nearness {
    width: u32
    height: u32
    nearness: Float32Array
}
