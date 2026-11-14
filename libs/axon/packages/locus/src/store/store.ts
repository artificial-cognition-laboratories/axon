import { err } from "@arcforge/err"
import type { SpaceHandle } from "../space"
import { assertBasis, type Coord } from "../coord"
import type { Hit, Id, LocusRecord, NearQuery, Query, RecordInput, Result } from "../types"
import { Basis, type BasisHandle } from "./basis"
import { Columns } from "./columns"
import { Consolidator, type ConsolidationOpts, type ConsolidationReport } from "./consolidate"
import { Planner } from "./plan"
import { Stats } from "./stats"
import type { Persistence, Row } from "./persistence"

export type StoreOpts = {
    space: SpaceHandle
    persistence: Persistence
}

/**
 * Records, their positions, and retrieval over both.
 *
 * Async because the columns must be COMPLETE before any query can be correct —
 * a half-loaded index would answer confidently and wrongly. That is the same
 * reason a session loads from disk in its factory: construction waits only for
 * state the handle must never be observed without.
 */
export async function Store(opts: StoreOpts) {
    const space = opts.space
    const persistence = opts.persistence
    const basis: BasisHandle = await Basis({ space: space, persistence: persistence })
    const columns = Columns({ space: space })
    const planner = Planner({ space: space, columns: columns })
    const stats = Stats({ space: space, columns: columns })
    const consolidator = Consolidator({ space: space, columns: columns })

    for (const row of await persistence.rows.all()) columns.put(row)

    const handle = {
        basis: basis,
        stats: stats,

        get count() {
            return columns.count
        },

        async put(input: RecordInput): Promise<Id> {
            const [id] = await handle.putMany([input])
            return id!
        },

        /**
         * Insert many in one transaction.
         *
         * The only way a large store gets loaded: per-record autocommit made 50k
         * rows take 4.6s, which is ~90s for a million and makes every experiment
         * above that size impractical. The index is updated first so a failed write
         * cannot leave the columns claiming rows the disk does not have.
         */
        async putMany(inputs: readonly RecordInput[]): Promise<Id[]> {
            const rows: Row[] = []
            const payloads: { id: Id; payload: unknown }[] = []
            const ids: Id[] = []

            for (const input of inputs) {
                assertBasis(space, input.coord)
                const id = input.id ?? crypto.randomUUID()
                const at = input.at ?? Date.now()
                ids.push(id)
                rows.push({ id: id, at: at, values: input.coord.values, conf: input.coord.conf })
                if (input.payload !== undefined) payloads.push({ id: id, payload: input.payload })
            }

            for (const row of rows) columns.put(row)
            await persistence.rows.putMany(rows)
            if (payloads.length > 0) await persistence.payload.putMany(payloads)

            return ids
        },

        async get(id: Id): Promise<LocusRecord> {
            const slot = columns.slot(id)
            if (slot === null) throw err("LOCUS_RECORD_NOT_FOUND", { detail: `no record with id ${id}`, context: { id: id } })
            return hydrate(slot, id)
        },

        async delete(id: Id): Promise<boolean> {
            return (await handle.deleteMany([id])) === 1
        },

        /** Remove many in one transaction. Returns how many were actually present. */
        async deleteMany(ids: readonly Id[]): Promise<number> {
            const present = ids.filter(id => columns.delete(id))
            if (present.length === 0) return 0
            await persistence.rows.deleteMany(present)
            await persistence.payload.deleteMany(present)
            return present.length
        },

        /** Narrow by predicates. No ranking — a box query has no notion of a best match. */
        async query(query: Query = {}): Promise<Result> {
            const selected = planner.select(query)
            return { hits: await hydrateAll(selected.slots), plan: selected.plan }
        },

        /** Narrow, then rank by distance. The one expensive step, run over the smallest possible set. */
        async near(target: Coord, query: NearQuery = {}): Promise<Result> {
            assertBasis(space, target)
            const ranked = planner.rank(target, query)
            const hits = await hydrateAll(ranked.slots)
            return {
                hits: hits.map((hit, index) => ({
                    ...hit,
                    distance: ranked.distances[index]!,
                    compared: ranked.compared[index]!,
                })),
                plan: ranked.plan,
            }
        },

        /**
         * The column slot holding a record, or null.
         *
         * Exposed so a caller can scope a consolidation to the rows a query
         * returned — "everything added since last sleep", "one region's members" —
         * which is the only way the cost stays bounded as a store grows.
         */
        slotOf(id: Id): number | null {
            return columns.slot(id)
        },

        /** Every live position, for a caller that needs the whole set — regions fitting, statistics, a migration. */
        coords(): { id: Id; coord: Coord }[] {
            const out: { id: Id; coord: Coord }[] = []
            for (const slot of columns.slotsLive()) {
                const id = columns.idAt(slot)
                if (id === null) continue
                out.push({ id: id, coord: columns.coord(slot) })
            }
            return out
        },

        /** Propose a consolidation without performing it. */
        planConsolidation(opts: ConsolidationOpts): ConsolidationReport {
            return consolidator.plan(opts)
        },

        /**
         * Consolidate: replace each cluster's members with their prototype.
         *
         * The prototype's payload records which ids it absorbed, so a
         * consolidated memory can still say what it was made of even after the
         * episodes themselves are gone.
         */
        async consolidate(opts: ConsolidationOpts): Promise<ConsolidationReport> {
            const report = consolidator.plan(opts)

            await handle.deleteMany(report.clusters.flatMap(cluster => cluster.members))
            await handle.putMany(
                report.clusters.map(cluster => ({
                    coord: cluster.prototype,
                    at: cluster.to,
                    payload: { consolidated: cluster.members, from: cluster.from, to: cluster.to },
                }))
            )

            return report
        },

        async close(): Promise<void> {
            await persistence.close()
        },
    }

    return handle

    async function hydrate(slot: number, id: Id): Promise<LocusRecord> {
        const payload = await persistence.payload.get(id)
        return {
            id: id,
            coord: columns.coord(slot),
            at: columns.at[slot]!,
            ...(payload !== null ? { payload: payload } : {}),
        }
    }

    /** Payloads fetched in ONE query, not one per hit — a 100-hit result was 100 round trips. */
    async function hydrateAll(slots: readonly number[]): Promise<Hit[]> {
        const pairs: { slot: number; id: Id }[] = []
        for (const slot of slots) {
            const id = columns.idAt(slot)
            if (id === null) continue
            pairs.push({ slot: slot, id: id })
        }

        const payloads = await persistence.payload.getMany(pairs.map(pair => pair.id))

        return pairs.map(pair => {
            const payload = payloads.get(pair.id)
            return {
                record: {
                    id: pair.id,
                    coord: columns.coord(pair.slot),
                    at: columns.at[pair.slot]!,
                    ...(payload !== undefined && payload !== null ? { payload: payload } : {}),
                },
            }
        })
    }
}

export type StoreHandle = Awaited<ReturnType<typeof Store>>
