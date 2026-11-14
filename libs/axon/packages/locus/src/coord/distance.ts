import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import { assertBasis } from "./coord"
import type { Coord } from "./types"

export type DistanceOpts = {
    /** Restrict to one domain. Omitted means every domain that can contribute. */
    domain?: string
}

/** What a domain contributed to a combined distance. The readable half of a ranking. */
export type DomainDistance = {
    domain: string
    distance: number
    weight: number
    /** How many axes were measured on BOTH sides. Zero means the domain sat out. */
    compared: number
}

/**
 * Distance in [0,1], computed over the MEASURED INTERSECTION and combined
 * across domains by weight.
 *
 * The measured-intersection rule is the one line of maths in this package that
 * has to be right on the first try. Because appending an axis is deliberately
 * free, old coordinates carry confidence 0 on it while new ones do not — so a
 * metric that treated unmeasured as zero would silently shift EVERY existing
 * pairwise distance the moment the ontology grew. You would see rankings change
 * after an addition with no data change, and it would take a long time to work
 * out why.
 *
 * Normalising per domain, then combining, is what keeps the number meaningful
 * as the space grows: distance is never computed across 200 dimensions at once
 * (where all distances converge and discrimination dies), only within groups of
 * five to fifteen.
 *
 * Throws rather than returning a number when nothing was comparable. Zero
 * similarity and an absence of comparison must not be indistinguishable to a
 * caller ranking results — use `explain` when you need to ASK whether two
 * positions are comparable, rather than catching a throw to find out.
 */
export function distance(space: SpaceHandle, a: Coord, b: Coord, opts: DistanceOpts = {}): number {
    const detail = explain(space, a, b, opts)
    if (detail.compared === 0) {
        throw err("LOCUS_NO_MEASURED_OVERLAP", {
            detail: opts.domain
                ? `no axis measured on both sides in domain "${opts.domain}"`
                : "no axis measured on both sides",
            context: { domain: opts.domain ?? null },
        })
    }
    return detail.distance
}

/** Distance inverted, `1 - distance`. Same rules, same throws. Linear, for when a plain complement is what you want. */
export function similarity(space: SpaceHandle, a: Coord, b: Coord, opts: DistanceOpts = {}): number {
    return 1 - distance(space, a, b, opts)
}

/**
 * How strongly one position generalises to another — `e^(-c·d)`.
 *
 * Shepard's universal law of generalization: the probability that a response
 * learned at one point transfers to another decays EXPONENTIALLY with distance,
 * not linearly. It is one of the more robust findings in psychology and it holds
 * across species and modalities, which is why Gärdenfors builds conceptual-space
 * similarity on it rather than on a complement.
 *
 * Note what this does and does not change. Both this and `similarity` are
 * monotone decreasing in distance, so **nearest-neighbour RANKING is identical
 * under either** — sorting cannot tell them apart. It matters only where the
 * VALUE is used: membership scores, thresholds, and any weighted average over
 * similarities. The practical difference is the tail: at `c = 3`, a distance of
 * 0.25 generalises at 0.47 and a distance of 1 at 0.05, so far things become
 * uniformly far instead of linearly less alike.
 *
 * `decay` is domain-specific in the literature and there is no universal value.
 * It belongs, eventually, to the concept rather than the space — Gärdenfors'
 * criterion for a concept includes its own salience weights.
 */
export function generalisation(
    space: SpaceHandle,
    a: Coord,
    b: Coord,
    opts: DistanceOpts & { decay?: number } = {}
): number {
    return Math.exp(-(opts.decay ?? SHEPARD_DECAY) * distance(space, a, b, opts))
}

/** Default exponential decay. Chosen so a quarter of the space away generalises at ~0.47 and the far corner at ~0.05. */
export const SHEPARD_DECAY = 3

/**
 * Distance with its per-domain breakdown.
 *
 * This is the version the debugger and the query planner use, and the reason
 * named axes are worth their cost: a ranking that cannot say WHICH domain moved
 * it is a ranking nobody can debug.
 */
export function explain(
    space: SpaceHandle,
    a: Coord,
    b: Coord,
    opts: DistanceOpts = {}
): { distance: number; domains: DomainDistance[]; compared: number } {
    assertBasis(space, a, b)

    const names = opts.domain ? [space.domains.get(opts.domain).name] : space.domains.names()
    const domains: DomainDistance[] = []

    let total = 0
    let weight = 0
    let compared = 0

    for (const name of names) {
        const domain = space.domains.get(name)
        const axes = space.domains.axesOf(name)
        const contribution = perDomain(space, a, b, name)
        domains.push({ domain: name, distance: contribution.distance, weight: domain.weight, compared: contribution.compared })
        if (contribution.compared === 0) continue

        // Weighted by COMPLETENESS: a domain compared on three of its twelve axes
        // is a three-sample estimate and must not carry the same authority as one
        // compared on all twelve. Lab e4 measured what happens without this —
        // recall@1 fell 0.855 to 0.165 as coverage thinned, while margin barely
        // moved, because scattered partial coverage turns every domain into a
        // tiny-sample estimate and the ranking is then won by whichever candidate
        // got lucky.
        //
        // At full coverage this is exactly 1 for every domain, so a deliberately
        // set weight still means what it says.
        const completeness = contribution.compared / axes.length
        const effective = domain.weight * completeness
        total += contribution.distance * effective
        weight += effective
        compared += contribution.compared
    }

    // NaN rather than 0 when nothing was comparable. `distance()` throws on
    // this, and a caller reading `.distance` while ignoring `.compared` gets a
    // value that poisons every comparison it touches instead of a plausible
    // "identical" — the failure is loud at the first use rather than silent
    // forever.
    return { distance: compared === 0 ? Number.NaN : total / weight, domains: domains, compared: compared }
}

/**
 * One domain's distance over the axes measured on both sides.
 *
 * `compared: 0` is the domain sitting out rather than the domain scoring 0 —
 * the caller combines only what contributed, so a domain nobody measured never
 * pulls a result toward "identical".
 *
 * This is the REFERENCE implementation. `store/rank.ts` holds a bulk, axis-major
 * version for ranking a whole corpus, and a hot test asserts the two agree
 * exactly on random inputs — duplication bound by an equivalence proof, because
 * the abstraction that avoided the duplication cost 50% throughput.
 */
function perDomain(space: SpaceHandle, a: Coord, b: Coord, name: string): { distance: number; compared: number } {
    const domain = space.domains.get(name)
    const indices = space.domains.axesOf(name)
    return domain.metric === "cosine" ? cosine(a, b, indices) : euclidean(a, b, indices)
}

/** Root-mean-square difference. Values are bounded to [0,1], so dividing by the count keeps the result there too. */
function euclidean(a: Coord, b: Coord, indices: readonly number[]): { distance: number; compared: number } {
    let sum = 0
    let compared = 0

    for (const i of indices) {
        if (a.conf[i]! === 0 || b.conf[i]! === 0) continue
        const delta = a.values[i]! - b.values[i]!
        sum += delta * delta
        compared++
    }

    if (compared === 0) return { distance: 0, compared: 0 }
    return { distance: Math.sqrt(sum / compared), compared: compared }
}

/**
 * Angle only, as `1 - cos`.
 *
 * A domain where both sides are all-zero has no direction to compare, so it
 * sits out rather than reporting a perfect match — which is what a naive
 * `0/0 → 0` would have claimed.
 */
function cosine(a: Coord, b: Coord, indices: readonly number[]): { distance: number; compared: number } {
    let dot = 0
    let magA = 0
    let magB = 0
    let compared = 0

    for (const i of indices) {
        if (a.conf[i]! === 0 || b.conf[i]! === 0) continue
        const va = a.values[i]!
        const vb = b.values[i]!
        dot += va * vb
        magA += va * va
        magB += vb * vb
        compared++
    }

    if (compared === 0) return { distance: 0, compared: 0 }
    const denom = Math.sqrt(magA) * Math.sqrt(magB)
    if (denom === 0) return { distance: 0, compared: 0 }
    return { distance: 1 - dot / denom, compared: compared }
}
