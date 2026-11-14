import type { Id } from "../../types"
import type { Persistence, Row, SerializedRegion, StoredBasis } from "./types"

/**
 * Persistence with no disk.
 *
 * **This is not a mock.** The engine above it — columns, planner, metric,
 * regions, consolidation — is the same code that runs against sqlite, so a hot
 * test using this backend is exercising the real system with durability
 * removed, not a stand-in for it. That is the whole reason the seam sits here
 * and not higher.
 */
export function MemoryPersistence(): Persistence {
    const rows = new Map<Id, Row>()
    const payloads = new Map<Id, unknown>()
    const regions = new Map<string, SerializedRegion>()
    let basis: StoredBasis | null = null

    return {
        rows: {
            async all() {
                return [...rows.values()]
            },
            async put(row) {
                rows.set(row.id, row)
            },
            async putMany(batch) {
                for (const row of batch) rows.set(row.id, row)
            },
            async delete(id) {
                rows.delete(id)
            },
            async deleteMany(ids) {
                for (const id of ids) rows.delete(id)
            },
        },
        payload: {
            async get(id) {
                return payloads.has(id) ? payloads.get(id) : null
            },
            async getMany(ids) {
                const found = new Map<Id, unknown>()
                for (const id of ids) if (payloads.has(id)) found.set(id, payloads.get(id))
                return found
            },
            async put(id, payload) {
                payloads.set(id, payload)
            },
            async putMany(entries) {
                for (const entry of entries) payloads.set(entry.id, entry.payload)
            },
            async delete(id) {
                payloads.delete(id)
            },
            async deleteMany(ids) {
                for (const id of ids) payloads.delete(id)
            },
        },
        regions: {
            async all() {
                return [...regions.values()]
            },
            async put(region) {
                regions.set(region.name, region)
            },
            async delete(name) {
                regions.delete(name)
            },
        },
        basis: {
            async read() {
                return basis
            },
            async write(next) {
                basis = next
            },
        },
        async close() {
            // Nothing to release. Kept for shape: a caller must be able to close
            // any Locus without asking which substrate it got.
        },
    }
}
