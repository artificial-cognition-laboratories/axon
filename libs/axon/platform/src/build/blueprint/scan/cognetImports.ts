import { dirname } from "node:path"
import {
    collectDefaultImports,
    findConfigProperty,
    parseConfig,
    resolveBinding,
    type ResolvedDeclaration,
} from "./configImports"

/**
 * Static resolution of a config file's `cognet:` declaration to the absolute
 * `cognet.config.ts` path of a SOURCE cognet.
 *
 * The mirror of resolveModulePaths(), and deliberately so: "how do I point at
 * local source" has one answer in this codebase, not two. An author writes
 * either a registry string or an imported binding, and both mean the same
 * thing they mean for a module.
 *
 * ```ts
 * cognet: "@axon/zero"                          // registry
 * cognet: Vehicle                               // source, from its import
 * ```
 *
 * Singular, not an array — an agent has one brain — so this returns one
 * result rather than a positional list, and there is no [entry, options]
 * tuple form to unwrap.
 *
 * A config with no `cognet:` at all resolves to null, which prepare reads as
 * "track the registry default", distinct from a declared-but-unresolvable
 * entry that must fail loudly.
 */

/** The config filenames a cognet import may point at. */
const COGNET_CONFIGS = ["cognet.config.ts", "cognet.config.js"] as const

/**
 * Resolve the config's `cognet:` entry. Returns null when the field is
 * absent — the agent declared no brain and inherits the default.
 */
export async function resolveCognetPath(configFilePath: string): Promise<ResolvedDeclaration | null> {
    const src = await parseConfig(configFilePath)
    if (!src) return null

    const cognetProperty = findConfigProperty(src, "cognet")
    if (!cognetProperty) return null

    return resolveBinding({
        element: cognetProperty,
        imports: collectDefaultImports(src),
        configDir: dirname(configFilePath),
        configFilePath,
        configNames: COGNET_CONFIGS,
        factory: "defineCognet",
        label: "cognet",
    })
}
