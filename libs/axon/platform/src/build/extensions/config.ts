import { isAbsolute, join, resolve } from "node:path"
import { homedir } from "node:os"
import { err } from "@arcforge/err"
import { withProviderGlobals } from "../blueprint"
import { ExtensionStore, parseRef, type ExtensionStoreT } from "./store"
import type { ExtensionEntry, ProfileConfig, ProviderEntry } from "@arcforge/types"
import { fsx } from "../../utils/fs"

/**
 * Loads and evaluates `profile.config.ts` — the user's declaration of WHICH
 * extensions load.
 *
 * The same capture mechanism `blueprint/scan/config.ts` uses for
 * `axon.config.ts`: install `defineProfile` as a global, import the file,
 * catch what it passed. Serialized through a lock so the synchronous capture
 * is unambiguous, and cache-busted so a reload picks up edits.
 *
 * Deliberately separate from the extension LOADING that follows it. This file
 * only answers "what is enabled" — reading it must not run any of it, which is
 * the property that lets `axon ext install` edit the list without executing a
 * single extension.
 */

type ProfileEvaluation = {
    capture(config: ProfileConfig): void
}

/**
 * One shared evaluation slot, on globalThis so every copy of this module
 * agrees. See scan/config.ts for why the lock exists rather than a stack: Bun
 * schedules concurrent import()s and then runs their synchronous evaluations
 * back-to-back, so a stack cross-captures.
 */
const PROFILE_EVALUATION = Symbol.for("axon.profile.evaluation")
const state = (() => {
    const shared = globalThis as typeof globalThis & {
        [PROFILE_EVALUATION]?: { current: ProfileEvaluation | null; lock: Promise<void> }
    }
    return shared[PROFILE_EVALUATION] ??= { current: null, lock: Promise.resolve() }
})()

function installProfileGlobals(): void {
    const g = globalThis as Record<string, unknown>
    g.defineProfile = (config: ProfileConfig) => {
        const evaluation = state.current
        if (!evaluation) throw err("PROFILE_CONFIG_INVALID", { detail: "defineProfile() called outside config evaluation" })
        evaluation.capture(config)
        return { _kind: "profile" as const, config }
    }
    // An extension's own config file may be imported while resolving a local
    // entry (it is what marks the directory), so its marker has to resolve
    // here too. Pure identity — an extension declares nothing today.
    g.defineExtension ??= (config: unknown = {}) => ({ _kind: "extension" as const, config })
}

installProfileGlobals()

/** One extension the profile asked for, normalized. */
export type ResolvedEntry = {
    /** As written in profile.config.ts — what an error message should quote. */
    source: string
    /** "local" resolves as a path from the profile root; "registry" installs by name. */
    kind: "local" | "registry"
    /** Absolute directory this extension does (or will) live in. */
    root: string
}

export type ProfileConfigResult = {
    /** Enabled entries, in declaration order. Empty when the config is absent. */
    entries: ResolvedEntry[]
    /**
     * The inference sources this profile declares, in declaration order.
     *
     * Projected here rather than read separately because this is already the
     * one place a profile's config is evaluated — a second reader would be a
     * second chance for the two to disagree about what the user wrote.
     *
     * Empty when the config is absent or declares none, which is the honest
     * state: an agent then runs on whatever it configures for itself.
     */
    /**
     * The inference sources this profile declares, in declaration order.
     *
     * UNDEFINED and EMPTY are different answers and must stay that way:
     * absent means the profile predates the field (or was never configured)
     * and gets the default pool; `[]` means the user deliberately declared
     * none and gets exactly that. Collapsing the two here is what made every
     * existing profile fail to boot — they all had no field, and `?? []`
     * reported that as "I have nothing".
     */
    providers: ProviderEntry[] | undefined
    /**
     * Why the config could not be read, if it could not be.
     *
     * Returned rather than thrown: a broken extension LIST must not stop the
     * profile's own main.ts and plugins/ from loading. The caller reports it
     * and carries on with no extensions.
     */
    error: unknown | null
}

/**
 * A local entry is one that looks like a path. Everything else is a registry
 * name — the same "./" | "../" | absolute test the module system uses, so a
 * user's intuition transfers between the two.
 */
function isLocalPath(source: string): boolean {
    return source.startsWith(".") || isAbsolute(source) || source.startsWith("~")
}

/** A local entry's absolute directory. `~` expands; everything else resolves from the profile root. */
function localRoot(profileRoot: string, source: string): string {
    if (source.startsWith("~")) return join(homedir(), source.slice(1))
    return isAbsolute(source) ? source : resolve(profileRoot, source)
}

/**
 * Where a registry extension lives: the MACHINE store, not this profile.
 *
 * `~/.axon/cache/extensions/<scope>/<name>/<version>/`. Profiles reference a
 * shared copy rather than each holding their own — see ExtensionStore for why
 * that is safe (nothing in a fetched extension is profile-relative) and what
 * it buys (one install and one prepare, however many profiles use it).
 *
 * An UNPINNED entry has no version to address, so it resolves to the newest
 * present. Every entry an install writes is pinned; this is the legacy shape,
 * kept working so a config written before pinning still loads.
 */
function registryRoot(store: ExtensionStoreT, source: string): string {
    const { name, version } = parseRef(source)
    if (version) return store.pathFor(name, version)

    // versions() is newest-first and semver-ordered — the store owns that
    // rule, and re-deriving "which is newest" here is how this drifted into a
    // second, lexical answer that disagreed with the store's own.
    const newest = store.versions(name)[0]
    // Nothing stored yet — the path an install will materialize into is
    // unknowable until the version resolves, so this names the directory the
    // name occupies. materialize() replaces it with the real one.
    return newest ? store.pathFor(name, newest) : join(store.root, ...name.split("/"))
}

/**
 * One source string → where it lives and how it gets there.
 *
 * Exported because installing takes a source the config does not yet contain,
 * so it cannot come from reading the config — but it must resolve to the same
 * place the loader will look for it afterwards.
 */
export function resolveEntry(source: string, profileRoot: string, store: ExtensionStoreT = ExtensionStore()): ResolvedEntry {
    return isLocalPath(source)
        ? { source, kind: "local", root: localRoot(profileRoot, source) }
        : { source, kind: "registry", root: registryRoot(store, source) }
}

function normalize(entry: ExtensionEntry, profileRoot: string, store: ExtensionStoreT): ResolvedEntry | null {
    const raw = typeof entry === "string" ? { source: entry } : entry
    if (typeof raw?.source !== "string" || raw.source.length === 0) {
        throw err("EXTENSION_ENTRY_INVALID", {
            detail: `expected a string or { source }, received ${JSON.stringify(entry)}`,
            context: { entry },
        })
    }
    // `enabled: false` keeps the line but does not load it — the point of the
    // object form, and what lets a CLI toggle one without losing the entry.
    if (typeof entry === "object" && entry.enabled === false) return null

    return resolveEntry(raw.source, profileRoot, store)
}

/**
 * Read a profile's extension list.
 *
 * A missing config is not an error — a profile that has never been configured
 * simply loads no extensions.
 */
export async function ProfileConfigFile(profileRoot: string, store: ExtensionStoreT = ExtensionStore()): Promise<ProfileConfigResult> {
    const configPath = join(profileRoot, "profile.config.ts")
    if (!fsx.exists(configPath)) return { entries: [], providers: undefined, error: null }

    let captured: ProfileConfig | null = null
    const evaluation: ProfileEvaluation = { capture: config => { captured = config } }

    let release!: () => void
    const previous = state.lock
    state.lock = new Promise<void>(resolve => { release = resolve })
    await previous

    try {
        state.current = evaluation
        try {
            // Cache-bust per call so a reload re-evaluates rather than being
            // served Bun's cached module — randomUUID, not Date.now(), which
            // collides within a millisecond.
            // Provider factories bound for the read: `providers: [Axon()]`
            // in a profile means the PROVIDER factory, and under `axon exec`
            // the bare global is the script's agent-booter. See
            // withProviderGlobals in scan/config.ts.
            // A BARE PATH, like scan/config.ts and for the same reason: this
            // relies on globals installed around the import surviving into the
            // module's evaluation, and a file:// URL loses that context. An
            // extension config imports nothing from node_modules, so the
            // resolution problem that forced pathToFileURL in the module loader
            // does not arise here.
            await withProviderGlobals(() => import(`${configPath}?t=${crypto.randomUUID()}`))
        } catch (cause) {
            return {
                entries: [],
                providers: undefined,
                error: err("PROFILE_CONFIG_FAILED", {
                    detail: `${configPath} — ${cause instanceof Error ? cause.message : String(cause)}`,
                    context: { configPath },
                    cause,
                }),
            }
        }

        if (!captured) {
            return {
                entries: [],
                providers: undefined,
                error: err("PROFILE_CONFIG_INVALID", { detail: configPath, context: { configPath } }),
            }
        }

        const config: ProfileConfig = captured
        const entries: ResolvedEntry[] = []
        // Validated as an ARRAY before iterating. `for...of` over a string
        // walks its characters, so `extensions: "@cody/theme"` — a plausible
        // typo, and the shape a single-entry config wants to be — silently
        // became one registry entry per letter, each fetched and each reported
        // missing. Eleven confusing errors for one obvious mistake.
        const declared = config.extensions
        if (declared !== undefined && !Array.isArray(declared)) {
            return {
                entries: [],
                providers: config.providers,
                error: err("EXTENSION_ENTRY_INVALID", {
                    detail: `extensions must be an array, received ${typeof declared}`,
                    context: { extensions: declared },
                }),
            }
        }

        for (const entry of declared ?? []) {
            try {
                const resolved = normalize(entry, profileRoot, store)
                if (resolved) entries.push(resolved)
            } catch (cause) {
                // One malformed entry does not invalidate the others — the
                // list is a set of independent requests, not a transaction.
                return { entries, providers: config.providers, error: cause }
            }
        }

        return { entries, providers: config.providers, error: null }
    } finally {
        state.current = null
        release()
    }
}
