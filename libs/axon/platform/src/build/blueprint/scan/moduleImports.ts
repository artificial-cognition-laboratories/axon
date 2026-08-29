import { dirname } from "node:path"
import type TsNamespace from "typescript"
import {
    collectDefaultImports,
    findConfigProperty,
    parseConfig,
    resolveBinding,
    tsc,
    type ResolvedDeclaration,
} from "./configImports"

/**
 * Static resolution of a config file's `modules: [...]` declaration to the
 * absolute `module.config.ts` path of each SOURCE module.
 *
 * This is how a source module's identity is recovered now that
 * `defineModule()` is pure and stamps nothing — see configImports.ts for the
 * shared machinery and why it resolves statically rather than at runtime.
 *
 * Resolution is POSITIONAL: entry N in the returned array corresponds to entry
 * N in the config's `modules: [...]` array, which is the same order the
 * evaluated config produces. A registry entry (a bare string) resolves to a
 * `registry` result — it has no source path; it is a package name resolved
 * from node_modules elsewhere.
 */

/** Module resolution is the shared shape — a module has no extra states. */
export type ResolvedModulePath = ResolvedDeclaration

/** The config filenames a module import may point at. */
const MODULE_CONFIGS = ["module.config.ts", "module.config.js"] as const

/**
 * Resolve every entry in a config's `modules: [...]` array to a path (or a
 * registry name). `configFilePath` is the file whose `defineAgent`/
 * `defineModule` call the array lives in — imports resolve relative to it.
 */
export async function resolveModulePaths(configFilePath: string): Promise<ResolvedModulePath[]> {
    const src = await parseConfig(configFilePath)
    if (!src) return []

    const modulesProperty = findConfigProperty(src, "modules")
    if (!modulesProperty || !tsc().isArrayLiteralExpression(modulesProperty)) return []

    const imports = collectDefaultImports(src)
    const configDir = dirname(configFilePath)
    const resolved: ResolvedModulePath[] = []

    for (const element of modulesProperty.elements) {
        resolved.push(await resolveEntry(element, imports, configDir, configFilePath))
    }
    return resolved
}

async function resolveEntry(
    element: TsNamespace.Expression,
    imports: Map<string, string>,
    configDir: string,
    configFilePath: string,
): Promise<ResolvedModulePath> {
    // ["registry-name", opts] | [Ident, opts] | [defineModule({...}), opts]
    // — the tuple form is module-only, so it stays here rather than in the
    // shared resolver. A cognet is singular and takes no options.
    if (tsc().isArrayLiteralExpression(element)) {
        const head = element.elements[0]
        if (head) return resolveEntry(head, imports, configDir, configFilePath)
        return { kind: "unresolved", detail: "empty module tuple in modules: [...]" }
    }

    return resolveBinding({
        element,
        imports,
        configDir,
        configFilePath,
        configNames: MODULE_CONFIGS,
        factory: "defineModule",
        label: "module",
    })
}
