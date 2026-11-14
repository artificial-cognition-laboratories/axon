/**
 * locus — situations, entities and memories as coordinates in a manifest
 * conceptual space.
 *
 * Two doors. This one is for a composition root: it builds a memory and holds a
 * connection. `@arcforge/locus/pure` is the basis and the algebra with no IO,
 * for producers and for every test of the maths.
 */
export { Locus, type LocusHandle, type LocusOpts, type Connection } from "./locus"
export { Store, type StoreHandle, MemoryPersistence, SqlitePersistence, type Persistence } from "./store"
export { Regions, type RegionsHandle } from "./regions"
export type { AxisStats, AxisCorrelation, CoverageStats, Cluster, ConsolidationReport, ConsolidationOpts } from "./store"
export type {
    Id,
    LocusRecord,
    RecordInput,
    Predicate,
    Query,
    NearQuery,
    Clause,
    Plan,
    Hit,
    Result,
} from "./types"
export * from "./pure"
