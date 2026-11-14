import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import { claimants, fit, has, membership, nearestPrototype, region, type Coord, type Region } from "../coord"
import type { Query } from "../types"
import type { Persistence, SerializedRegion } from "../store"
import type { StoreHandle } from "../store"

export type RegionsOpts = {
    space: SpaceHandle
    store: StoreHandle
    persistence: Persistence
}

/**
 * The persisted collection of named concepts.
 *
 * Regions are LEARNED artifacts, not configuration — fitted from members or
 * opened when nothing claims a position — so they live beside the records rather
 * than in code. And because one Region type does five jobs, this one handle is
 * simultaneously the identity mechanism, the novelty detector, the consolidation
 * target set, the goal-state library and the behaviour precondition index.
 */
export async function Regions(opts: RegionsOpts) {
    const space = opts.space
    const store = opts.store
    const persistence = opts.persistence

    const table = new Map<string, Region>()
    for (const stored of await persistence.regions.all()) table.set(stored.name, deserialize(space, stored))

    const handle = {
        get count() {
            return table.size
        },

        list(): Region[] {
            return [...table.values()]
        },

        get(name: string): Region {
            const found = table.get(name)
            if (!found) throw err("LOCUS_REGION_NOT_FOUND", { detail: `no region named "${name}"`, context: { region: name } })
            return found
        },

        exists(name: string): boolean {
            return table.has(name)
        },

        /** Fit a region from whatever a query returns. The bridge between retrieval and concept formation. */
        async fitFrom(name: string, query: Query, opts: { radius?: number; domain?: string; spread?: number } = {}): Promise<Region> {
            const found = await store.query(query)
            const members = found.hits.map(hit => hit.record.coord)
            return handle.save(fit(space, name, members, opts))
        },

        /** Fit from coordinates directly. */
        async fitOf(name: string, members: readonly Coord[], opts: { radius?: number; domain?: string; spread?: number } = {}): Promise<Region> {
            return handle.save(fit(space, name, members, opts))
        },

        /**
         * Open a new region around a position nobody claimed.
         *
         * Concept formation, and the same call as novelty: `claims()` coming back
         * empty is what justifies opening one. A region of a single member is a
         * guess, honestly marked by its count.
         */
        async open(name: string, seed: Coord, opts: { radius?: number; domain?: string } = {}): Promise<Region> {
            return handle.save(region({ name: name, prototypes: [seed], ...opts }))
        },

        /** Fold a position into an existing region, widening it or adding a prototype. */
        async absorb(name: string, position: Coord): Promise<Region> {
            const current = handle.get(name)
            const nearest = nearestPrototype(space, current, position)
            const prototypes = nearest > current.radius ? [...current.prototypes, position] : current.prototypes
            return handle.save(region({ ...current, prototypes: prototypes, count: current.count + 1 }))
        },

        /**
         * Which regions claim this position, nearest first.
         *
         * An EMPTY result is the novelty signal — which is why `encounters === 1`
         * generalises here from "never seen this thing" to "never seen anything
         * like this", and why identity and novelty need no separate mechanisms.
         */
        claims(position: Coord): { region: Region; distance: number }[] {
            return claimants(space, handle.list(), position)
        },

        /** How strongly a position belongs, graded. The caller owns the threshold, so it can hold hysteresis. */
        membership(name: string, position: Coord, opts: { decay?: number } = {}): number {
            return membership(space, handle.get(name), position, opts)
        },

        has(name: string, position: Coord): boolean {
            return has(space, handle.get(name), position)
        },

        async delete(name: string): Promise<boolean> {
            if (!table.delete(name)) return false
            await persistence.regions.delete(name)
            return true
        },

        async save(next: Region): Promise<Region> {
            table.set(next.name, next)
            await persistence.regions.put(serialize(next))
            return next
        },
    }

    return handle
}

export type RegionsHandle = Awaited<ReturnType<typeof Regions>>

function serialize(r: Region): SerializedRegion {
    return {
        name: r.name,
        radius: r.radius,
        count: r.count,
        ...(r.domain !== undefined ? { domain: r.domain } : {}),
        prototypes: r.prototypes.map(prototype => ({ values: prototype.values, conf: prototype.conf })),
    }
}

function deserialize(space: SpaceHandle, stored: SerializedRegion): Region {
    return region({
        name: stored.name,
        radius: stored.radius,
        count: stored.count,
        ...(stored.domain !== undefined ? { domain: stored.domain } : {}),
        prototypes: stored.prototypes.map(prototype =>
            Object.freeze({ space: space.version, values: prototype.values, conf: prototype.conf })
        ),
    })
}
