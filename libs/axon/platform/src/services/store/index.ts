// store — the one interface to ~/.axon. Store() is the module's single entry point.

export { Store, storeRoot, type StoreT, type ProfileT } from "./store"
export type {
    ActiveProfile,
    AppIntent,
    AppState,
    AgentManifest,
    EnvTarget,
    HistoryEntry,
    ProfileRecord,
    ProfileSettings,
    UpdateRecord,
    VerbosityProfile,
} from "./types"
