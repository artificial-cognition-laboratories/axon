import { err } from "@arcforge/err"
import { KERNEL_ABI_VERSION } from "@arcforge/types"
import { DEFAULT_COGNET, inlineCognetDir } from "../blueprint"
import type { ManifestT } from "./manifest"
import type { InstallerT, ModuleUpdate } from "./installer"
import type { TreeT } from "./tree"

type CognetOpts = {
    manifest: ManifestT
    installer: InstallerT
    tree: TreeT
}

export type CognetT = ReturnType<typeof Cognet>

/**
 * The agent's brain, as an updatable dependency.
 *
 * A cognet is an ordinary registry package (`@axon/zero` in package.json),
 * installed by the same installer as everything else — so this owns no
 * resolution, fetching or pinning of its own. What it owns is the two facts
 * that make a cognet different from a module:
 *
 *   ONE, NOT MANY. An agent has exactly one brain, so the surface is a single
 *   answer rather than a list. Swapping it for a different cognet is a change
 *   of mind, not a version bump, and is deliberately not offered here.
 *
 *   ABI-GATED. A cognet bundle is fused to one kernel contract. "Latest" on
 *   its own can name a version this runtime cannot load, so every resolution
 *   here passes KERNEL_ABI_VERSION and an incompatible version is never
 *   selected — rather than being installed and failing later at compile time.
 *
 * Not exposed for a SOURCE cognet (an inline `cognet/` directory or a local
 * import): that is a checked-out tree the author edits, with no version to
 * move it to. Callers get null and should say so rather than offer an update
 * that cannot mean anything.
 */
export function Cognet(opts: CognetOpts) {
    const { manifest, installer, tree } = opts

    /**
     * The installed cognet's package name, or null when this agent runs a
     * source cognet.
     *
     * Falls back to DEFAULT_COGNET when the config declares nothing, because
     * that is exactly what prepare installs in the same case — an agent that
     * chose no brain still HAS one, and reporting null would hide the most
     * common agent of all from its own update command.
     */
    async function name(): Promise<string | null> {
        // An inline cognet/ directory is a source tree the author edits —
        // checked FIRST because it wins over an absent declaration and, when
        // both exist, prepare itself refuses the agent as ambiguous. Either
        // way there is no published version to move to.
        if (inlineCognetDir(manifest.root)) return null

        const declared = await manifest.config.cognet()
        // No `cognet:` key and no inline folder: the agent tracks the registry
        // default. Reporting null here would hide the most common agent of all
        // from its own update command — prepare installs DEFAULT_COGNET in
        // exactly this case.
        if (!declared) return DEFAULT_COGNET

        // A registry declaration is a bare scoped name, optionally pinned.
        // Anything else (a relative path) is a source cognet.
        if (!declared.startsWith("@")) return null

        // Strip a pinned version — package.json keys on the name alone.
        // lastIndexOf, not indexOf: the scope's own "@" leads the string.
        const at = declared.lastIndexOf("@")
        return at > 0 ? declared.slice(0, at) : declared
    }

    return {
        /**
         * What this agent's brain could move to, or null when there is
         * nothing updatable (a source cognet).
         *
         * Read-only and safe to call on a palette render: it asks the registry
         * what exists and touches no manifest, tree or bundle. Mirrors
         * `installer.updates()` per-entry semantics exactly — `current: null`
         * is declared-but-not-installed, `latest: null` is a registry that
         * could not be reached, and neither is ever `outdated`, so a caller
         * reading that flag can never act on a version it does not know.
         */
        async updates(): Promise<ModuleUpdate | null> {
            const packageName = await name()
            if (!packageName) return null

            const declared = await manifest.package.dependencies.all()
            const range = declared[packageName] ?? ""
            const current = tree.installedVersion(packageName)

            try {
                const latest = await installer.resolve(packageName, undefined, KERNEL_ABI_VERSION)
                return {
                    name: packageName,
                    range,
                    current,
                    latest,
                    outdated: current !== null && latest !== current,
                }
            } catch {
                return { name: packageName, range, current, latest: null, outdated: false }
            }
        },

        /**
         * Move the brain to an explicit version.
         *
         * Just `install()` at a ref, exactly as `installer.update()` is: the
         * pinning, the registry-origin bookkeeping and the already-installed
         * short circuit are all what an update needs, and a second code path
         * would be the same operation free to disagree with the first.
         *
         * `declare: false` because the cognet is not a module — prepare
         * installs it the same way, and adding it to `modules: [...]` would
         * make the blueprint load the brain twice.
         *
         * `keepRange` so moving a version does not silently convert the
         * author's `^1.0.10` into a hard pin.
         *
         * The version is REQUIRED. The caller has already resolved it and
         * shown the user what they are agreeing to; re-resolving here could
         * land somewhere newer than that between the row rendering and the
         * keypress.
         */
        async update(version: string): Promise<void> {
            const packageName = await name()
            if (!packageName) {
                throw err("COGNET_NOT_FOUND", {
                    detail: "this agent runs a source cognet — there is no published version to update to",
                })
            }

            const [result] = await installer.install([`${packageName}@${version}`], {
                declare: false,
                keepRange: true,
                abi: KERNEL_ABI_VERSION,
            })

            if (result?.status === "not-found") {
                throw err("COGNET_NOT_FOUND", {
                    detail: `no published ${packageName}@${version} for kernel ABI ${KERNEL_ABI_VERSION}`,
                    context: { name: packageName, version },
                })
            }
            if (result?.status === "error") {
                throw err("COGNET_NOT_FOUND", {
                    detail: result.error,
                    context: { name: packageName, version },
                })
            }
        },
    }
}
