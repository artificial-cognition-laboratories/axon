// cognet — the agent's brain: resolve a specifier, compile it, read it back.
// Cognet() is the module's single entry point.

export { Cognet, cognetSourceOf, inlineCognetDir, INLINE_COGNET_DIR, type CognetT, type CognetSource } from "./cognet"
export { SCHEMA_DIR, SCHEMA_SPECIFIER, type CognetArtifact } from "./bundle"
export { contractOf } from "./schema"
export { DEFAULT_COGNET, cognetName } from "./resolve"

// The ABI gate. prepare() compares a cognet against this kernel; publish
// records the declared value on the version row without comparing.
export { cognetAbi } from "./abi"
export { CognetConfigFile, ProviderFile, type CognetConfigFileT } from "./config"
