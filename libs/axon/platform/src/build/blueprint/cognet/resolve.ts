import { dirname, join, resolve } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"

/**
 * Cognet specifier → source project directory.
 *
 * A cognet is an ordinary registry artifact installed as an ordinary package:
 * `cognet: "@axon/zero"` in axon.config.ts becomes a package.json dependency,
 * Bun fetches it through the registry's npm surface, and it lands in
 * node_modules like anything else. This function is the last step — finding
 * the installed source tree so bundleCognet() can compile it.
 *
 * It used to resolve against a directory shipped inside the CLI bundle, which
 * meant exactly one cognet existed and it could only ever be the one the CLI
 * was built with. The old comment here predicted this change: "when cognets
 * become installable, the install target resolves HERE and nothing else in
 * the pipeline moves." That is what happened — bundleCognet() is unchanged.
 *
 * The default is @axon/zero, published like any other cognet and installed
 * like any other dependency. There is deliberately no bundled fallback: a
 * cognet the agent declares but has not installed is a prepare-time error,
 * never a silent substitution of something else.
 */
export const DEFAULT_COGNET = "@axon/zero"

/**
 * The dangling symlink standing where a package should be, if that is why it
 * did not resolve.
 *
 * Grafted projects hold one symlink per top-level entry, pointing into the
 * machine-wide tree cache. When that cache evicts the tree, every link goes
 * dangling at once and the package reads as simply absent — which is true but
 * deeply misleading, because the manifest is correct and the user changed
 * nothing.
 */
function danglingLink(agentRoot: string, name: string): { link: string; target: string } | null {
    // The scope directory is what gets linked ("@axon"), not the package
    // inside it, so that is where a broken graft shows up.
    const [scope] = name.split("/")
    let dir = resolve(agentRoot)
    while (true) {
        for (const candidate of [join(dir, "node_modules", ...name.split("/")), join(dir, "node_modules", scope!)]) {
            const target = fsx.readLink(candidate)
            if (target && !fsx.exists(target)) return { link: candidate, target }
        }
        const parent = dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

/**
 * Walk up from the agent root looking for the installed package, the way a
 * module resolver would — an agent inside a workspace resolves against the
 * workspace's node_modules, not only its own.
 */
export function resolveCognet(specifier: string, agentRoot: string): string {
    const name = cognetName(specifier)

    let dir = resolve(agentRoot)
    while (true) {
        const candidate = join(dir, "node_modules", ...name.split("/"))
        if (fsx.exists(join(candidate, "cognet.config.ts"))) return candidate
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
    }

    // A DANGLING link is a different fact from an absent package, and blaming
    // the user's config for it sends them looking for a typo that is not
    // there. It means node_modules was grafted onto a shared cache tree that
    // has since been deleted — machine state, nothing to do with the manifest.
    //
    // Reported separately because the remedy is different too: a missing
    // package is fixed by declaring or installing it, while this is fixed by
    // reinstalling, and no amount of editing axon.config.ts will touch it.
    const dangling = danglingLink(agentRoot, name)
    if (dangling) {
        throw err("COGNET_NOT_FOUND", {
            detail:
                `cognet "${name}" is installed but its files are gone: ${dangling.link} points at ` +
                `${dangling.target}, which no longer exists.\n` +
                `This is a stale node_modules, not a problem with your config — the shared dependency ` +
                `cache it was linked into has been cleared.\n` +
                `Fix: delete node_modules and run \`axon prepare\`.`,
            context: { specifier, name, agentRoot, link: dangling.link, target: dangling.target },
        })
    }

    // Deliberately does NOT say "run axon prepare": prepare is what resolves
    // the cognet, so this message is usually printed BY prepare, and telling
    // someone to run the command that just failed is a dead end. State what
    // was looked for and where — the reconcile step is what makes this
    // reachable-but-absent case self-healing, and if it still surfaces, the
    // useful fact is the path that was searched.
    throw err("COGNET_NOT_FOUND", {
        detail: `cognet "${name}" is declared but not present in node_modules under ${agentRoot}`,
        context: { specifier, name, agentRoot },
    })
}

/** "@axon/zero@1.2.0" → "@axon/zero". The version range is Bun's concern, not ours. */
export function cognetName(specifier: string): string {
    if (!specifier.startsWith("@")) {
        throw err("COGNET_NOT_FOUND", {
            detail: `"${specifier}" is not a scoped cognet name — expected @scope/name`,
            context: { specifier },
        })
    }
    const at = specifier.indexOf("@", 1)
    return at === -1 ? specifier : specifier.slice(0, at)
}
