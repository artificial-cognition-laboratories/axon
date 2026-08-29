import { dirname, join, resolve } from "node:path"
import { fsx } from "../../../utils/fs"
import type { ManifestT } from "../manifest"
import { hashModule } from "./hash"
import { Lock } from "./lock"

/** One declared source module: its root on disk and the names it is known by. */
export type SourceModule = {
    /** Short name, e.g. "fs" — what the blueprint scanner keys modules by. */
    name: string
    /** Full package name, e.g. "@axon/fs" — how package.json refers to it. */
    packageName: string
    root: string
}

export type LinkResult = {
    /** Whether the module's content changed since the last prepare. */
    status: "linked" | "unchanged"
    name: string
    contentHash: string
    /** Whether package.json gained or changed this module's `file:` entry — the caller's signal that a real install is needed. */
    dependenciesChanged: boolean
}

type SourceModulesOpts = {
    root: string
    /** The agent's declaration files — the one owner of its dependency map. */
    manifest: ManifestT
}

/**
 * SourceModules — local modules hard-imported by the agent's config.
 *
 * Declared via `defineModule()` in axon.config.ts (hostDir/../mods/x/module.config.ts,
 * Nuxt-style) rather than pulled from the registry. They have no semver of
 * their own: their identity is a content hash of what is on disk, recorded in
 * the lock at prepare time.
 *
 * Their DEPENDENCIES are Bun's problem, not ours. A source module is declared
 * as a `file:` dependency in the agent's package.json, so Bun links it and
 * installs its dependencies exactly as it would for a published package. That
 * replaced a hand-rolled dependency merge which spliced a module's deps into
 * the agent's manifest and threw when two modules declared incompatible ranges
 * — a conflict Bun resolves by nesting. Registry and source modules now
 * resolve through one mechanism, which is what "a module's origin must never
 * change how its deps resolve" was always trying to say.
 */
export function SourceModules(opts: SourceModulesOpts) {
    const root = opts.root
    const manifest = opts.manifest
    const lock = Lock({ root: root })

    /**
     * Point package.json at the module on disk.
     *
     * The path is ABSOLUTE. A relative `file:` specifier resolves against the
     * manifest's own location, and Tree.install() deliberately copies the
     * manifest into a temp directory to escape a surrounding monorepo workspace
     * — at which point "../mods/x" names nothing. Source modules are by
     * definition local and unpublished, so a machine-specific path costs
     * nothing: a fresh clone re-derives it on the next prepare.
     */
    function specifierFor(module: SourceModule): string {
        return `file:${toPosix(resolve(module.root))}`
    }

    return {
        lock: lock,

        /** Derive a module's root, short name, and package name from its module.config.ts path. */
        async resolve(configPath: string): Promise<SourceModule> {
            const moduleRoot = dirname(configPath)
            const text = await fsx.readText(join(moduleRoot, "package.json"))
            const declared = text ? (JSON.parse(text) as { name?: string }).name : undefined
            const packageName = declared ?? basename(moduleRoot)

            return {
                name: packageName.includes("/") ? packageName.split("/").pop()! : packageName,
                packageName: packageName,
                root: moduleRoot,
            }
        },

        /**
         * Declare a module as a `file:` dependency and record its content hash.
         * Returns "unchanged" when the hash matches the last prepare.
         */
        async link(module: SourceModule): Promise<LinkResult> {
            const dependenciesChanged = await manifest.package.dependencies.set({
                [module.packageName]: specifierFor(module),
            })

            const contentHash = await hashModule(module.root)
            const previous = await lock.recorded(module.name)
            await lock.record(module.name, { sourcePath: module.root, contentHash: contentHash })

            return {
                status: previous === contentHash ? "unchanged" : "linked",
                name: module.name,
                contentHash: contentHash,
                dependenciesChanged: dependenciesChanged,
            }
        },

        /**
         * Drop `file:` dependencies for modules the config no longer declares,
         * and their stale lock entries. Returns the removed package names.
         *
         * prepare() only ever added: removing a `defineModule()` import left its
         * `file:` dependency behind forever, so Bun kept linking the local
         * directory and installing the same module from the registry could
         * never replace it. The config is the declaration — a `file:` dep with
         * nothing declaring it is dead.
         *
         * Only `file:` deps are considered. A registry module is removed by
         * `axon uninstall`, and the agent's own npm dependencies are the
         * author's.
         *
         * The FRAMEWORK is exempt. It is legitimately `file:` when an agent
         * points at a local checkout — how the framework is developed, and
         * how the test suite links the tree under test — and it is not a
         * source module, so this would prune it on the very prepare that
         * declared it. The symptom is a manifest with `overrides` and no
         * `@arcforge/*` dependencies, then "cognet is not installed".
         */
        async prune(declared: SourceModule[]): Promise<string[]> {
            const live = new Set(declared.map(module => module.packageName))
            const dependencies = await manifest.package.dependencies.all()

            const dead = Object.entries(dependencies)
                .filter(([name, specifier]) =>
                    specifier.startsWith("file:")
                    && !live.has(name)
                    && !name.startsWith("@arcforge/"))
                .map(([name]) => name)
            if (dead.length === 0) return []

            const removed = await manifest.package.dependencies.remove(dead)
            // The lock is keyed by short name, not package name.
            await lock.forget(removed.map(name => (name.includes("/") ? name.split("/").pop()! : name)))

            return removed
        },
    }
}

export type SourceModulesT = ReturnType<typeof SourceModules>

function basename(path: string): string {
    return path.split("/").pop()!
}

function toPosix(path: string): string {
    return path.split(/[\\/]/).join("/")
}
