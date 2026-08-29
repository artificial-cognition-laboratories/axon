export { Artifacts } from "./artifacts"
export type { ArtifactsHandle } from "./artifacts"
export { Artifact, parseArtifactRecord } from "./artifact"
export type { ArtifactHandle } from "./artifact"
export { ARTIFACT_KINDS } from "./types"
export { SORT_ORDERS, parseKinds, parseLimit, parseSort, refine } from "./search"
export type { SearchInput, SortOrder } from "./search"
/**
 * `Bundle` is deliberately NOT re-exported here.
 *
 * It reads the local filesystem — a publish-time operation, never something a
 * browser calls. Re-exporting it put `bundle.ts` in the browser's module graph
 * for anything importing this barrel, and Vite then externalises
 * `node:fs/promises` to a stub with no named exports. Production tree-shakes
 * the unused function away, so it only ever surfaced as a build warning; dev
 * has no such luxury, and a re-optimised dep cache turned it into a 500 on
 * whatever page happened to reach it.
 *
 * The one consumer (`artifact.ts`) imports it directly from `./bundle`, which
 * is the honest dependency. Anything else that genuinely needs it should do the
 * same rather than reach through an isomorphic barrel for a Node-only function.
 */
export type {
    ArtifactAsset,
    ArtifactKind,
    ArtifactRecord,
    ArtifactStats,
    ArtifactUpdate,
    ArtifactVersion,
    ResolvedArtifact,
} from "./types"
