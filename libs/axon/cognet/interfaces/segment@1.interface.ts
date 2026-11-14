import type { Picture } from "./media"

/**
 * Regions of a picture, found from a prompt. Encoding the picture is the costly
 * part, so it is done once and asked about many times.
 */
export interface Segment {
    describe(): {
        /** The longest side it encodes at. */
        maxSide: u32
    }

    /** Encodes a picture, kept by the provider until released. */
    encode(picture: Picture): Promise<Encoded>

    /** The region a prompt picks out of an encoded picture. */
    mask(encoded: Encoded, prompt: Prompt): Promise<Mask>
}

/** A picture, encoded — kept by the provider, never crossing. */
export type Encoded = Handle<"Encoded">

/** Where to look, in the picture's own pixels: a point on the region, or a box around it. */
export interface Prompt {
    point?: [f64, f64]
    box?: [f64, f64, f64, f64]
}

/**
 * One region: `width × height` cells over the whole picture, row by row from the
 * top, 1 inside and 0 out. `score` is the model's own estimate of its quality, 0 to 1.
 */
export interface Mask {
    width: u32
    height: u32
    mask: Uint8Array
    score: f64
}
