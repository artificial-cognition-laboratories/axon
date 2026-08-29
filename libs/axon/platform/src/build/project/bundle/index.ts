// bundle — package a project into its publishable artifact.
// Bundle() is the module's single entry point.

export { Bundle, type BundleT } from "./bundle"
export type { ArtifactsT } from "./artifacts"
// Assets is exported as well as its types: the source bundler owns the publish
// path, but the leaf is independently testable and worth keeping that way.
export { Assets, type AssetsT, type AssetReport, type AssetsResult } from "./assets"
export type {
    AgentImage,
    ModuleImage,
    SourceImage,
    BundleImage,
    BundleArtifact,
    BundleIdentity,
} from "./types"
