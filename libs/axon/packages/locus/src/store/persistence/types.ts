import type { Id } from "../../types"
import type { Region } from "../../coord"

/** A row as it durably exists — the coordinate as raw components, no basis attached. */
export type Row = {
    id: Id
    at: number
    values: Float32Array
    conf: Float32Array
}

/** The basis as stored, so a mismatch with the code's Space is detectable before a single float is interpreted. */
export type StoredBasis = {
    version: string
    /** Human ordering, for migration history. The version is the identity. */
    ordinal: number
    /** The axis names in their stored order — what makes a mismatch readable rather than just unequal. */
    axes: string[]
    writtenAt: number
}

/**
 * Where bytes durably live.
 *
 * The ONE swappable seam between a memory store and a sqlite-backed one: the
 * engine above this is identical in both cases, which is what makes the
 * in-memory backend a real substrate rather than a mock. Remote is deliberately
 * NOT a variant here — a remote Locus has no local engine at all, so it swaps
 * the whole handle rather than its persistence.
 */
export type Persistence = {
    rows: {
        all(): Promise<Row[]>
        put(row: Row): Promise<void>
        /** One transaction for the whole batch. A million single inserts is ~90s; batched it is seconds. */
        putMany(rows: readonly Row[]): Promise<void>
        delete(id: Id): Promise<void>
        deleteMany(ids: readonly Id[]): Promise<void>
    }
    payload: {
        get(id: Id): Promise<unknown | null>
        /** One query for the whole set. Hydrating a 100-hit result one await at a time is 100 round trips. */
        getMany(ids: readonly Id[]): Promise<Map<Id, unknown>>
        put(id: Id, payload: unknown): Promise<void>
        putMany(entries: readonly { id: Id; payload: unknown }[]): Promise<void>
        delete(id: Id): Promise<void>
        deleteMany(ids: readonly Id[]): Promise<void>
    }
    regions: {
        all(): Promise<SerializedRegion[]>
        put(region: SerializedRegion): Promise<void>
        delete(name: string): Promise<void>
    }
    basis: {
        read(): Promise<StoredBasis | null>
        write(basis: StoredBasis): Promise<void>
    }
    close(): Promise<void>
}

/** A region on its way to disk. Prototypes are coordinates, so they serialise the same way rows do. */
export type SerializedRegion = {
    name: string
    radius: number
    count: number
    domain?: string
    prototypes: { values: Float32Array; conf: Float32Array }[]
}

export type { Region }
