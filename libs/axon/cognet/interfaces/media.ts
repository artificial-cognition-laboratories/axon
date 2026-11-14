/** What the standard interfaces see and hear with, shared between them. */

/** A picture: `width × height` pixels, row by row from the top, three bytes each — red, green, blue. */
export interface Picture {
    width: u32
    height: u32
    rgb: Uint8Array
}

/** Sound: mono samples between -1 and 1, `rate` of them a second. */
export interface Sound {
    rate: u32
    samples: Float32Array
}
