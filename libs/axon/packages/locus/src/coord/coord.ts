import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import type { Coord, Reading } from "./types"

/** An unmeasured position — every axis present, nothing claimed about any of them. */
export function empty(space: SpaceHandle): Coord {
    return freeze(space.version, new Float32Array(space.axes.length), new Float32Array(space.axes.length))
}

/**
 * Build a position from readings.
 *
 * Axes nobody supplied stay at confidence 0 — unmeasured, not zero — which is
 * what lets a space GROW without invalidating anything: append an axis and
 * every existing coordinate is still valid, it simply has not been asked that
 * question yet.
 *
 * Two producers supplying the same axis throws. Exactly one producer owns each
 * axis, for the same reason exactly one system writes each ECS component: two
 * disagreeing sources is a drift no query could ever surface.
 *
 * Readings are validated against [0,1] here, at the only door into the space.
 * Out of range is not a rounding problem — it breaks the normalisation every
 * metric depends on, and a value of 1.03 averaged into a prototype corrupts a
 * concept quietly rather than failing.
 */
export function coord(space: SpaceHandle, readings: Iterable<readonly [string, Reading]>): Coord {
    const values = new Float32Array(space.axes.length)
    const conf = new Float32Array(space.axes.length)

    for (const [name, reading] of readings) {
        const i = space.axes.index(name)
        if (conf[i] !== 0) {
            throw err("LOCUS_AXIS_DOUBLE_WRITTEN", { detail: `two producers supplied "${name}"`, context: { axis: name } })
        }
        range(name, "value", reading.value)
        range(name, "confidence", reading.confidence)
        values[i] = reading.value
        conf[i] = reading.confidence
    }

    return freeze(space.version, values, conf)
}

/** Build a position from a plain object of readings — the ergonomic form for tests and hand-written patterns. */
export function from(space: SpaceHandle, readings: Record<string, Reading | number>): Coord {
    const entries: [string, Reading][] = Object.entries(readings).map(([name, reading]) => [
        name,
        typeof reading === "number" ? { value: reading, confidence: 1 } : reading,
    ])
    return coord(space, entries)
}

/** Read one axis. Returns null when it was never measured — never a bare 0, which would be a claim. */
export function read(space: SpaceHandle, position: Coord, name: string): Reading | null {
    const i = space.axes.index(name)
    const confidence = position.conf[i]!
    if (confidence === 0) return null
    return { value: position.values[i]!, confidence: confidence }
}

/** Was this axis measured on this position at all? */
export function measured(space: SpaceHandle, position: Coord, name: string): boolean {
    return position.conf[space.axes.index(name)]! > 0
}

/** Every measured axis, as names. The honest answer to "what does this position actually claim?" */
export function claims(space: SpaceHandle, position: Coord): string[] {
    const names: string[] = []
    for (let i = 0; i < position.conf.length; i++) {
        if (position.conf[i]! > 0) names.push(space.axes.at(i).name)
    }
    return names
}

/** Reject a position that came from another basis, or that has the wrong arity. */
export function assertBasis(space: SpaceHandle, ...positions: readonly Coord[]): void {
    for (const position of positions) {
        if (position.space !== space.version) {
            throw err("LOCUS_BASIS_VERSION_CONFLICT", {
                detail: `coordinate is from basis ${position.space}, space is ${space.version}`,
                context: { coord: position.space, space: space.version },
            })
        }
        if (position.values.length !== space.axes.length || position.conf.length !== space.axes.length) {
            throw err("LOCUS_COORD_ARITY", {
                detail: `expected ${space.axes.length}, got ${position.values.length}`,
                context: { expected: space.axes.length, got: position.values.length },
            })
        }
    }
}

/**
 * A position is a point, and points do not move. Freezing the handle stops the
 * common accident — a stored coordinate being tagged again after the fact,
 * which would rewrite history rather than adding to it.
 *
 * The backing arrays are not deep-frozen (typed arrays cannot be), so this is a
 * guard rather than a proof. Every function in this module returns a new
 * coordinate rather than mutating one.
 */
/** The unit cube is the whole contract of an axis. Anything outside it is refused where it enters. */
function range(axis: string, field: "value" | "confidence", n: number): void {
    if (Number.isFinite(n) && n >= 0 && n <= 1) return
    throw err("LOCUS_READING_OUT_OF_RANGE", {
        detail: `${axis}.${field} was ${n}`,
        context: { axis: axis, field: field, got: n },
    })
}

function freeze(space: string, values: Float32Array, conf: Float32Array): Coord {
    return Object.freeze({ space: space, values: values, conf: conf })
}
