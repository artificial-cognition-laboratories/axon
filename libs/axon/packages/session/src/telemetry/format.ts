/**
 * The telemetry ring's on-disk format — an encoder and a decoder that agree.
 *
 * A segment is a header, then records, each prefixed by its length:
 *
 *   "AXTL" u16 version u16 0
 *   u32 length | u8 op | ...
 *
 *   op STRING  u32 id, u32 bytes, utf-8     — defines one entry of the segment's string table
 *   op EVENT   u32 seq, f64 ms, u32 type, value(rest of the envelope)
 *
 * ONE generic value encoding rather than a layout per event type: nothing
 * here can drift from the event types, because nothing here names them. What
 * makes it cheap is what JSON spends its time on — repeated names and long
 * runs of numbers:
 *
 * - Short strings are INTERNED per segment: `L0/world/map/map`, `values`,
 *   `self` cross once per segment and are four bytes after.
 * - A run of numbers is a BLOCK: one tag and raw bytes, as the narrowest
 *   integer that holds them — scaled by a power of ten when that is exact,
 *   so a field rounded to hundredths is two bytes a cell — or float64. Never
 *   float32: every value reads back exactly. A 64×36 field is one copy to
 *   read rather than 2,304 number parses.
 *
 * Each segment carries its own string table, so a reader can start at any
 * segment — which is what lets the oldest be deleted without breaking the rest.
 *
 * The value semantics are JSON's wherever JSON has one (toJSON is honoured,
 * undefined object members are dropped), so an event reads back as it would
 * from the log. Where JSON is lossy, this is not: NaN stays NaN, and a typed
 * array stays a typed array instead of becoming an object of indices.
 */

export const MAGIC = 0x4c545841 // "AXTL", little-endian
export const VERSION = 1
/** Header bytes at the start of every segment. */
export const HEADER_BYTES = 8

export const OP = { string: 1, event: 2 } as const

export const TAG = {
    null: 0, undefined: 1, false: 2, true: 3,
    int: 4, float: 5, ref: 6, text: 7,
    array: 8, object: 9,
    numbers: 10,
    typed: 11,
} as const

/**
 * How a block of numbers is stored: the narrowest integer that holds every
 * value scaled by 10^decimals, or float64 when no scale makes them whole.
 * Exact either way — a value is scaled only when k / 10^d reads back as
 * precisely that value, which is what a field rounded to hundredths is.
 */
export const WIDTH = { u8: 0, i16: 1, i32: 2, f64: 3 } as const
/** The finest scale tried: millionths. */
export const MOST_DECIMALS = 6

/** Strings up to this many characters are interned; longer ones — messages, stacks — are written inline. */
export const INTERN_MOST = 64
/** Number arrays at least this long are written as a block. */
export const BLOCK_LEAST = 4

/** Typed array kinds, by their index here. */
export const TYPED = [Float32Array, Float64Array, Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array] as const
export type Typed = InstanceType<(typeof TYPED)[number]>

/** An envelope as the session commits it: a type, a time, and whatever else it carries. */
export type Envelope = { type: string; time: { ms: number; seq: number } }

/** An envelope read back: everything it carried besides type and time, as written. */
export type Decoded = Envelope & Record<string, unknown>
