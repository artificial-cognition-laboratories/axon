// project — finding, opening, creating, and preparing agent/module projects.
// Projects() is the module's single entry point.

export { Projects, type ProjectsT, type CreateStep } from "./projects"
export type { ProjectKind, ProjectT } from "./project"
export { detectKind } from "./kinds"
// Exported because the extension loader watches a PROFILE, which is a project
// root that nothing calls Project() on — it is scaffolded and loaded rather
// than opened. The watcher itself is kind-agnostic.
export { Watcher, type WatcherT } from "./watcher"
export type { PrepareResult } from "./prepare"
// PublishStep is the CLI's progress contract — a publish spends real time in
// each step, and the renderer needs the union to know what it is showing.
export type { PublishResult, PublishStep } from "./publish"
export type { InstallResult, UninstallResult, ModuleUpdate } from "./installer"
export type { AgentImage, ModuleImage, SourceImage, BundleArtifact, BundleIdentity } from "./bundle"
export { Assets, type AssetsT, type AssetReport, type AssetsResult } from "./bundle"
export type { TypegenResult } from "./typegen"
export { Manifest, type ManifestT, type ConfigArray } from "./manifest"
export type { ModelT, ModelSetResult } from "./manifest"
export type { EngineEffort } from "@arcforge/types"
export { SourceModules, type SourceModulesT, type SourceModule, type LinkResult } from "./modules"
export { Tree, type TreeT } from "./tree"
export { TreeCache, type TreeCacheT } from "./treecache"
export { reconcile, type ReconcileResult } from "./reconcile"
export { verify, graftBroken, describeFaults, type Fault, type VerifyReport } from "./verify"

// The frame layout, for consumers that need to POINT at generated output they
// did not write — Fleet linking a user to their tool scope, say. Exported
// because the alternative is what Fleet actually did: hand-spell
// `.agent/tool-globals.d.ts`, miss that the frame groups declarations under
// `types/`, and silently render an existsSync() that is now never true. A
// layout with one owner needs one accessor reachable from outside it.
export { Frame, type FrameT, type FrameArea } from "../frame"

// Model weights — declared by a cognet, fetched and verified here, handed to
// the brain as absolute paths. An asset store that happens to be used for ML.
export { Models, ModelStore, parseModel, parseModels, downloadUrl, basenameOf, fetchModel } from "./models"
export type { ModelsT, ResolveResult, ModelStoreT, StoredModel, ParsedModel } from "./models"
export { parseSpecifier } from "./specifier"
