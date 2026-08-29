// blueprint — agent directory in, AxonPartialBlueprint out.
// Blueprint() is the module's single entry point.

export { Blueprint, type BlueprintT, type BlueprintResult } from "./blueprint"
export type { Scanned, ScanWarning } from "./types"

// Standalone scanners for consumers outside the blueprint composition
// (typegen needs components; dev tooling may scan single domains).
export { Components, type PromptComponent } from "./scan/components"

// The config authority — Project.prepare reads declared modules through the
// same loader Blueprint composes with. One implementation, promoted on purpose.
export { Config, withProviderGlobals, type LoadedConfig } from "./scan/config"

// The brain toolchain. prepare() gates a cognet's ABI before compiling it;
// publish() records the declared abi on the version row.
export { Cognet, cognetSourceOf, inlineCognetDir, INLINE_COGNET_DIR, type CognetT, type CognetSource, type CognetArtifact, DEFAULT_COGNET, cognetName, cognetAbi, readCognetAbi, readCognetModels, readCognetEngines } from "./cognet"
export { flatten, sourceRoot, type NormalisedEntry } from "./modules/entries"

/**
 * The authored server surface, re-scannable agent-side.
 *
 * Routes, middleware and plugins are the three things the blueprint carries
 * as FUNCTIONS, which is why the agent has to rebuild them rather than
 * receive them — see rehydrateServer in link/agent-main.ts.
 */
export { Routes } from "./scan/routes"
export { Middleware } from "./scan/middleware"
export { Plugins } from "./scan/plugins"
