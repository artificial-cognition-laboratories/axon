import type { Picture } from "./media"

/**
 * How far away each part of a picture is, in metres — from the camera, along
 * its axis. A metric model knows the scale of the world; one that does not is
 * `depth-relative@1`, and must never be offered as this.
 */
export interface DepthMetric {
    describe(): {
        /** The longest side it estimates at; a larger picture is answered at this, and scaled. */
        maxSide: u32
    }

    /** Depth for every cell of a grid over the whole picture. */
    estimate(picture: Picture): Promise<DepthMap>
}

/**
 * `width × height` cells covering the whole picture, row by row from the top —
 * coarser than the picture when the model is; scale by its width over this
 * one's. Each is metres from the camera; 0 where the model has no answer.
 */
export interface DepthMap {
    width: u32
    height: u32
    metres: Float32Array
}
