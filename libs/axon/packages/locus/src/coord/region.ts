import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import { distance, generalisation } from "./distance"
import { centroid } from "./shape"
import type { Coord } from "./types"

/**
 * A named set of positions — the most load-bearing type in this package.
 *
 * One type does five jobs, and they are all the same arithmetic:
 *
 *   a kind                  the nearest region claims the point
 *   novelty                 NO region claims the point
 *   a consolidation target  the centroid absorbs its members
 *   a goal state            distance to it, plus the named gaps
 *   a behaviour precondition  containment decides whether it applies
 *
 * Multiple prototypes rather than one, because a concept is often not a single
 * blob: if "building block" is really wood-like AND stone-like, a single
 * centroid lands between the two clusters, in empty space, matching neither.
 * Membership is the best over prototypes, and a member too far from all of them
 * opens a new one — which is the same operation as concept formation.
 */
export type Region = {
    readonly name: string
    readonly prototypes: readonly Coord[]
    /** Distance within which a position belongs. */
    readonly radius: number
    /** How many members were folded in. A region of one is a guess; a region of four hundred is a concept. */
    readonly count: number
    /** Which domain membership is judged in. Omitted means all of them. */
    readonly domain?: string
}

export type RegionOpts = {
    name: string
    prototypes: readonly Coord[]
    radius?: number
    count?: number
    domain?: string
}

/**
 * Fallback radius, used only when a region is opened from a single seed and there
 * are no members to measure.
 *
 * **Prefer a FITTED radius.** A constant is meaningless across axis tables: lab
 * E2b measured the same-vs-other distance margin shrinking 20-46% as redundant
 * axes were added, with `recall@1` completely unmoved. Ranking is immune to
 * redundancy; an absolute threshold is not. So a radius chosen by hand silently
 * claims too much the moment the space grows, and novelty detection degrades with
 * no symptom. `fit()` derives it from the members instead.
 */
export const DEFAULT_RADIUS = 0.25

/** How many standard deviations of member spread a fitted radius covers. */
export const FIT_SIGMAS = 2

export function region(opts: RegionOpts): Region {
    if (opts.prototypes.length === 0) {
        throw err("LOCUS_EMPTY_INPUT", { detail: `region "${opts.name}" has no prototypes`, context: { region: opts.name } })
    }
    return Object.freeze({
        name: opts.name,
        prototypes: Object.freeze([...opts.prototypes]),
        radius: opts.radius ?? DEFAULT_RADIUS,
        count: opts.count ?? opts.prototypes.length,
        ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
    })
}

/**
 * Build a region from its members.
 *
 * `spread` is how far apart members may be before they get their own prototype.
 * Left unset, one prototype is fitted over everything — correct when the members
 * genuinely form one cluster, and the wrong answer stated loudly when they do
 * not, which a radius check will reveal.
 */
export function fit(
    space: SpaceHandle,
    name: string,
    members: readonly Coord[],
    opts: { radius?: number; domain?: string; spread?: number; sigmas?: number } = {}
): Region {
    if (members.length === 0) {
        throw err("LOCUS_EMPTY_INPUT", { detail: `cannot fit region "${name}" from no members`, context: { region: name } })
    }

    const clusters = opts.spread === undefined ? [members] : cluster(space, members, opts.spread, opts.domain)
    const prototypes = clusters.map(group => centroid(space, group))
    const radius = opts.radius ?? fitRadius(space, prototypes, members, opts)

    return region({
        name: name,
        prototypes: prototypes,
        radius: radius,
        count: members.length,
        ...(opts.domain !== undefined ? { domain: opts.domain } : {}),
    })
}

/**
 * How strongly a position belongs, in [0,1] — the best over prototypes.
 *
 * Graded rather than boolean because the commitment belongs to the CALLER: L1
 * adopts a name on one threshold and abandons it on a lower one, and a region
 * that decided for it could not support that hysteresis.
 *
 * Exponential rather than `1 - d` (Shepard's law) because this is the one place
 * the VALUE is consumed rather than sorted. `has()` and `claimants()` order by
 * raw distance and are unaffected — ranking is invariant under any monotone
 * transform, so only a graded score can tell the two apart.
 */
export function membership(space: SpaceHandle, r: Region, position: Coord, opts: { decay?: number } = {}): number {
    let best = 0
    for (const prototype of r.prototypes) {
        const scoped = r.domain === undefined ? {} : { domain: r.domain }
        const score = generalisation(space, prototype, position, { ...scoped, ...opts })
        if (score > best) best = score
    }
    return best
}

/** Does this region claim this position? The nearest prototype within the radius. */
export function has(space: SpaceHandle, r: Region, position: Coord): boolean {
    return nearestPrototype(space, r, position) <= r.radius
}

/** Distance to the nearest prototype. The raw number `has` and `membership` are built from. */
export function nearestPrototype(space: SpaceHandle, r: Region, position: Coord): number {
    let best = Number.POSITIVE_INFINITY
    for (const prototype of r.prototypes) {
        const scoped = r.domain === undefined ? {} : { domain: r.domain }
        const d = distance(space, prototype, position, scoped)
        if (d < best) best = d
    }
    return best
}

/**
 * Which regions claim this position, nearest first.
 *
 * An empty result is the novelty signal, and it is the same call as recognition
 * — which is why `encounters === 1` generalises here from "never seen this
 * thing" to "never seen anything like this".
 */
export function claimants(
    space: SpaceHandle,
    regions: readonly Region[],
    position: Coord
): { region: Region; distance: number }[] {
    return regions
        .map(r => ({ region: r, distance: nearestPrototype(space, r, position) }))
        .filter(hit => hit.distance <= hit.region.radius)
        .sort((a, b) => a.distance - b.distance)
}

/** Fold a position into a region, as a new prototype or as weight on the nearest one. */
export function absorb(space: SpaceHandle, r: Region, position: Coord): Region {
    const nearest = nearestPrototype(space, r, position)

    if (nearest > r.radius) {
        return region({ ...r, prototypes: [...r.prototypes, position], count: r.count + 1 })
    }

    // Pull the closest prototype toward the new member, weighted by how much it
    // already represents — an old prototype with four hundred members should not
    // be dragged by the four hundred and first.
    const index = r.prototypes.findIndex(p => {
        const scoped = r.domain === undefined ? {} : { domain: r.domain }
        return distance(space, p, position, scoped) === nearest
    })
    const prototypes = [...r.prototypes]
    prototypes[index] = centroid(space, [...Array(r.count).fill(prototypes[index]!), position])

    return region({ ...r, prototypes: prototypes, count: r.count + 1 })
}

/**
 * A radius derived from how far the members actually sit from their prototype:
 * `mean + sigmas x sd`.
 *
 * Scale-free, which is the point. The absolute distance at which "the same
 * concept" ends depends on the axis table, the domain weights and the metric —
 * none of which a hand-chosen constant knows about. Measuring the members makes
 * the region carry its own scale, so adding axes moves the members and the radius
 * together instead of moving only one of them.
 */
function fitRadius(
    space: SpaceHandle,
    prototypes: readonly Coord[],
    members: readonly Coord[],
    opts: { domain?: string; sigmas?: number }
): number {
    const scoped = opts.domain === undefined ? {} : { domain: opts.domain }
    const distances: number[] = []

    for (const member of members) {
        let nearest = Number.POSITIVE_INFINITY
        for (const prototype of prototypes) {
            const d = distance(space, prototype, member, scoped)
            if (d < nearest) nearest = d
        }
        if (Number.isFinite(nearest)) distances.push(nearest)
    }

    if (distances.length === 0) return DEFAULT_RADIUS
    if (distances.length === 1) return Math.max(distances[0]!, Number.EPSILON)

    const mean = distances.reduce((sum, d) => sum + d, 0) / distances.length
    const variance = distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length
    return mean + (opts.sigmas ?? FIT_SIGMAS) * Math.sqrt(variance)
}

/** Greedy single-pass clustering: the cheapest thing that finds obvious groups. */
function cluster(space: SpaceHandle, members: readonly Coord[], spread: number, domain?: string): Coord[][] {
    const groups: Coord[][] = []
    const scoped = domain === undefined ? {} : { domain: domain }

    for (const member of members) {
        const home = groups.find(group => distance(space, group[0]!, member, scoped) <= spread)
        if (home) home.push(member)
        else groups.push([member])
    }

    return groups
}
