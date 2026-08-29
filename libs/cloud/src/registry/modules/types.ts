import type { ArtifactRecord, ArtifactStats, ArtifactUpdate, ArtifactVersion } from "../artifacts/types"

/**
 * A module IS a registry artifact — same row, same routes, same parsing.
 *
 * These aliases exist so consumers that speak in modules keep reading
 * naturally (`ModuleRecord` on a module page) without a second definition of
 * the same shape drifting from the first. The parallel `ModuleRecord` that
 * used to live here carried `moduleId` where the artifact carries
 * `artifactId`, which meant every module screen re-parsed identical JSON into
 * a differently-named object.
 *
 * New code can use the artifact names directly; these are domain vocabulary
 * over one canonical type, not a second type.
 */
export type ModuleRecord = ArtifactRecord
export type ModuleVersion = ArtifactVersion
export type ModuleStats = ArtifactStats
export type ModuleUpdate = ArtifactUpdate

/**
 * The install path's payload — a name resolved to a downloadable tarball.
 *
 * Genuinely module-specific and NOT `ResolvedArtifact`: this is what the
 * module installer consumes, keyed on `moduleId`, rather than what the catalog
 * hands to something browsing.
 */
export type ResolvedModule = {
    moduleId: string
    name: string
    version: string
    downloadUrl: string
}
