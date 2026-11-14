import { err } from "@arcforge/err"
import type { MemoryConnection } from "@arcforge/types"
import type { SpaceHandle } from "./space"
import { MemoryPersistence, SqlitePersistence, Store, type Persistence } from "./store"
import { Regions } from "./regions"

/**
 * Where a Locus keeps its bytes — the kernel's `MemoryConnection`, so what a
 * cognet is handed by `kernel.memory.connect()` opens here untouched.
 *
 * A discriminated union so `path` is required exactly where it means something —
 * an opts object with an optional path that is mandatory half the time is an
 * invalid state left representable.
 */
export type Connection = MemoryConnection

export type LocusOpts = {
    space: SpaceHandle
    conn: Connection
}

/**
 * THE MEMORY — records at a position in a manifest conceptual space, queried by
 * narrowing on exact predicates and ranked by distance in that space.
 *
 * Wiring only. Every child is constructed above the return and the return is
 * assignment, so the body reads as the dependency graph and the shape reads as
 * the surface.
 *
 * ## Why `memory` and `sqlite` are not two backends
 *
 * They are one engine with a different persistence leaf. Columns live in RAM
 * either way; only durability differs. That is what makes the in-memory
 * substrate a REAL substrate rather than a mock — a hot test against it
 * exercises the actual planner, metric, regions and consolidation.
 *
 * `remote` is a different thing again: it has no local engine at all, so it
 * swaps the whole handle rather than its persistence. Declared here so
 * `LocusHandle` is the one contract both paths satisfy and the remote client can
 * never drift from the local one; unwired, so it throws rather than pretending.
 */
export async function Locus(opts: LocusOpts) {
    const space = opts.space
    const persistence = connect(opts.conn)
    const store = await Store({ space: space, persistence: persistence })
    const regions = await Regions({ space: space, store: store, persistence: persistence })

    return {
        space: space,
        basis: store.basis,
        records: store,
        regions: regions,
        stats: store.stats,
        close: store.close,
    }
}

export type LocusHandle = Awaited<ReturnType<typeof Locus>>

/** The persistence leaf for a connection. A switch, so each case is narrowed to its own fields. */
function connect(conn: Connection): Persistence {
    switch (conn.type) {
        case "memory":
            return MemoryPersistence()
        case "sqlite":
            return SqlitePersistence({ path: conn.path })
        case "remote":
            throw err("LOCUS_REMOTE_UNWIRED", { detail: "remote is not wired yet — use a memory or sqlite connection" })
    }
}
