// extensions — the user's TUI config: their own main.ts and plugins/, plus
// every extension profile.config.ts enables.
//
// Extensions() is the module's single entry point.

export { Extensions, type ExtensionsT, type ExtensionsResult, type ExtensionUpdate } from "./extensions"
export { ProfileConfigFile, resolveEntry, type ResolvedEntry, type ProfileConfigResult } from "./config"
export { addEntry, addProvider, readEntries, readPolicy, readProviders, readSettings, removeEntry, removeProvider, setSetting, type EditResult } from "./edit"
export { DisposerSink, type LoadedSource, type LoadedFile } from "./load"
export { ExtensionStore, formatRef, parseRef, type ExtensionStoreT, type StoredExtension } from "./store"
