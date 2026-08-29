// ollama — local models, programmatically.
// Ollama() is the module's single entry point.

export { Ollama, type OllamaT } from "./ollama"
export { CATALOG } from "./catalog"
export type {
    Capability,
    CatalogModel,
    LocalModel,
    OllamaStatus,
    PullProgress,
    RunningModel,
} from "./types"
