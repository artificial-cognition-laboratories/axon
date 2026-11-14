import type { Picture } from "./media"

/**
 * A vector for what a text or a picture means, so that two near in meaning are
 * near in space. Vectors from two providers are not comparable: a mind keeps
 * one provider's vectors together, and asks `describe()` which it has.
 */
export interface Embed {
    describe(): {
        /** How many numbers a vector holds. */
        dimensions: u32
        /** Which spaces vectors are in — two providers reporting the same name are comparable. */
        space: string
    }

    /** The vector for a text. */
    text(text: string): Promise<Embedding>

    /** The vector for a picture. */
    picture(picture: Picture): Promise<Embedding>
}

/** A vector, `dimensions` long, of length 1. */
export interface Embedding {
    vector: Float32Array
}
