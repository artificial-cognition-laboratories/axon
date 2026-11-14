import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import { assertBasis } from "./coord"
import type { Coord, Gap } from "./types"

/**
 * What is typical of both — the mean over axes measured on both sides.
 *
 * Deliberately NOT called `intersect`. It is a restricted centroid, and the
 * average is correct for that; it is simply not a set intersection, and naming
 * it one is what leads to it being used as a fuzzy AND (see logic.match, which
 * is what that use actually wanted).
 */
export function commonality(space: SpaceHandle, a: Coord, b: Coord): Coord {
    assertBasis(space, a, b)
    const values = new Float32Array(a.values.length)
    const conf = new Float32Array(a.conf.length)

    for (let i = 0; i < a.conf.length; i++) {
        const confA = a.conf[i]!
        const confB = b.conf[i]!
        if (confA === 0 || confB === 0) continue
        values[i] = (a.values[i]! + b.values[i]!) / 2
        conf[i] = Math.min(confA, confB)
    }

    return Object.freeze({ space: a.space, values: values, conf: conf })
}

/**
 * The named, signed gap from a position to a target — sorted by how much it matters.
 *
 * This is the reason named axes earn their cost. A scalar distance says "not
 * there yet"; this says WHICH axes are short and by how much, which is a stop
 * condition and a ranked list of what to do next from one computation. An
 * opaque embedding can produce the first and never the second.
 *
 * Only axes measured on both sides appear: a gap to an axis nobody measured is
 * not a gap, it is an unasked question.
 */
export function difference(space: SpaceHandle, target: Coord, current: Coord): Gap[] {
    assertBasis(space, target, current)
    const gaps: Gap[] = []

    for (let i = 0; i < target.conf.length; i++) {
        if (target.conf[i]! === 0 || current.conf[i]! === 0) continue
        const gap = target.values[i]! - current.values[i]!
        if (gap === 0) continue
        gaps.push({ axis: space.axes.at(i).name, gap: gap })
    }

    return gaps.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
}

/**
 * The average position across several — a prototype.
 *
 * An axis is measured on the result when at least one member measured it, and
 * its value is the mean over only those members. Confidence is scaled by
 * coverage, so a prototype built from one member's opinion out of fifty is
 * honestly marked as weakly held rather than presented as firm.
 */
export function centroid(space: SpaceHandle, positions: readonly Coord[]): Coord {
    if (positions.length === 0) {
        throw err("LOCUS_EMPTY_INPUT", { detail: "centroid of no coordinates" })
    }
    assertBasis(space, ...positions)

    const length = space.axes.length
    const values = new Float32Array(length)
    const conf = new Float32Array(length)
    const counts = new Uint32Array(length)

    for (const position of positions) {
        for (let i = 0; i < length; i++) {
            const confidence = position.conf[i]!
            if (confidence === 0) continue
            values[i] = values[i]! + position.values[i]!
            conf[i] = conf[i]! + confidence
            counts[i] = counts[i]! + 1
        }
    }

    for (let i = 0; i < length; i++) {
        const count = counts[i]!
        if (count === 0) continue
        values[i] = values[i]! / count
        conf[i] = (conf[i]! / count) * (count / positions.length)
    }

    return Object.freeze({ space: space.version, values: values, conf: conf })
}

/** A position part-way between two. `t=0` is `a`, `t=1` is `b`. */
export function interpolate(space: SpaceHandle, a: Coord, b: Coord, t: number): Coord {
    assertBasis(space, a, b)
    const values = new Float32Array(a.values.length)
    const conf = new Float32Array(a.conf.length)

    for (let i = 0; i < a.conf.length; i++) {
        const confA = a.conf[i]!
        const confB = b.conf[i]!
        if (confA === 0 || confB === 0) continue
        values[i] = a.values[i]! + (b.values[i]! - a.values[i]!) * t
        conf[i] = Math.min(confA, confB)
    }

    return Object.freeze({ space: a.space, values: values, conf: conf })
}

/**
 * Move a position along a direction, clamped to the cube.
 *
 * The direction is `Gap[]`, not a `Coord`, because **a direction is not a
 * position**: a position is bounded to [0,1] and a direction is signed. Giving
 * them one type would either let a negative membership exist or make "move away
 * from this" unrepresentable.
 *
 * Which means `difference` and `shift` compose exactly — `difference` produces a
 * direction, `shift` consumes one — so moving a belief part-way toward a goal is
 * one line, and that is the whole of the descending bias operation:
 *
 *     shift(space, current, difference(space, goal, current), 0.5)
 *
 * Axes the position has not measured are left unmeasured. You cannot push a
 * belief you do not hold, and inventing one here is how an imagined value would
 * become indistinguishable from a sensed one.
 */
export function shift(space: SpaceHandle, position: Coord, direction: readonly Gap[], factor = 1): Coord {
    assertBasis(space, position)
    const values = new Float32Array(position.values)
    const conf = new Float32Array(position.conf)

    for (const step of direction) {
        const i = space.axes.index(step.axis)
        if (conf[i]! === 0) continue
        values[i] = clamp(values[i]! + step.gap * factor)
    }

    return Object.freeze({ space: position.space, values: values, conf: conf })
}

function clamp(value: number): number {
    if (value < 0) return 0
    if (value > 1) return 1
    return value
}
