import type { SpaceHandle } from "../space"
import { assertBasis } from "./coord"
import type { Coord } from "./types"

/**
 * Fuzzy conjunction operators — the valid ANDs on [0,1].
 *
 * These are t-norms, and the family is closed and well studied. The boundary
 * condition `T(a, 0) = 0` is what makes one legitimate: `average` fails it
 * (`avg(0.8, 0) = 0.4`, half-presence from an absence), which is why averaging
 * is `commonality` in shape.ts and not an AND.
 *
 *   min           the bottleneck. Ignores how strong the stronger side is.
 *   product       both must genuinely hold. Punishes weakness in either.
 *   lukasiewicz   strictest. Anything short of a combined surplus is zero.
 */
export const TNORMS = {
    min: (a: number, b: number) => Math.min(a, b),
    product: (a: number, b: number) => a * b,
    lukasiewicz: (a: number, b: number) => Math.max(0, a + b - 1),
} as const

/** Their matching ORs, each the De Morgan dual of the t-norm above it. */
export const TCONORMS = {
    max: (a: number, b: number) => Math.max(a, b),
    probabilistic: (a: number, b: number) => a + b - a * b,
    lukasiewicz: (a: number, b: number) => Math.min(1, a + b),
} as const

export type TNorm = keyof typeof TNORMS
export type TConorm = keyof typeof TCONORMS

/**
 * How much is BOTH true at once, axis by axis.
 *
 * Note what this is not: it is not the intersection of two result sets. Those
 * are different operations at different levels — one combines the coordinates of
 * a single thing, the other combines collections — and conflating them is how a
 * pattern match starts over-reporting. Set operations on collections live on
 * Region; this one lives on a position.
 */
export function conjunction(space: SpaceHandle, a: Coord, b: Coord, opts: { tnorm?: TNorm } = {}): Coord {
    return combine(space, a, b, TNORMS[opts.tnorm ?? "min"])
}

/** How much is EITHER true, axis by axis. */
export function disjunction(space: SpaceHandle, a: Coord, b: Coord, opts: { tconorm?: TConorm } = {}): Coord {
    return combine(space, a, b, TCONORMS[opts.tconorm ?? "max"])
}

/**
 * How much is NOT true, axis by axis.
 *
 * Only measured axes are negated. An unmeasured axis complements to unmeasured,
 * never to 1 — "nobody asked whether it was noisy" must not become "certainly
 * not noisy", which is the single most tempting way to invent a belief.
 */
export function complement(space: SpaceHandle, a: Coord): Coord {
    assertBasis(space, a)
    const values = new Float32Array(a.values.length)
    const conf = new Float32Array(a.conf.length)

    for (let i = 0; i < a.conf.length; i++) {
        const confidence = a.conf[i]!
        if (confidence === 0) continue
        values[i] = 1 - a.values[i]!
        conf[i] = confidence
    }

    return Object.freeze({ space: a.space, values: values, conf: conf })
}

/**
 * How well does a pattern hold against a position, in [0,1].
 *
 * `1` means every axis the pattern asks about is satisfied at least as strongly
 * as it asks. Below that is how close it is — which is what "how near are we to
 * triggering this" actually means, as opposed to averaging a conjunction and
 * inflating every partial match.
 *
 * Axes the pattern does not measure are not asked about. Axes the pattern asks
 * about that the POSITION has not measured count as unsatisfied — an unasked
 * question is not a passed one.
 */
export function match(space: SpaceHandle, pattern: Coord, position: Coord, opts: { tnorm?: TNorm } = {}): number {
    assertBasis(space, pattern, position)
    const tnorm = TNORMS[opts.tnorm ?? "min"]

    let held = 0
    let asked = 0

    for (let i = 0; i < pattern.conf.length; i++) {
        if (pattern.conf[i]! === 0) continue
        const wanted = pattern.values[i]!
        if (wanted === 0) continue
        asked += wanted
        const have = position.conf[i]! === 0 ? 0 : position.values[i]!
        held += tnorm(wanted, have)
    }

    if (asked === 0) return 1
    return held / asked
}

/** Every axis measured on both sides, folded with one operator. */
function combine(space: SpaceHandle, a: Coord, b: Coord, op: (a: number, b: number) => number): Coord {
    assertBasis(space, a, b)
    const values = new Float32Array(a.values.length)
    const conf = new Float32Array(a.conf.length)

    for (let i = 0; i < a.conf.length; i++) {
        const confA = a.conf[i]!
        const confB = b.conf[i]!
        if (confA === 0 || confB === 0) continue
        values[i] = op(a.values[i]!, b.values[i]!)
        // A combination is only as trustworthy as its weakest input.
        conf[i] = Math.min(confA, confB)
    }

    return Object.freeze({ space: a.space, values: values, conf: conf })
}
