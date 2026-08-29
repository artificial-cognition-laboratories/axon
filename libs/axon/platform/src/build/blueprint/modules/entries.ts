import { dirname } from "node:path"
import type { ModuleConfig, ModuleEntry } from "@arcforge/types"
import { resolveModulePaths, type ResolvedModulePath } from "../scan/moduleImports"

/**
 * Declared-entry normalisation. A ModuleEntry in axon.config.ts is one of:
 *   "name" · ModuleConfig · ["name", opts] · [ModuleConfig, opts]
 * Everything downstream works with the canonical two-kind form.
 *
 * A source module's identity is its `configPath` — the absolute path to its
 * module.config.ts, resolved STATICALLY from the import that declared it (see
 * scan/moduleImports). It is threaded in positionally: `modulePaths[i]`
 * corresponds to the i-th entry of the config's `modules: [...]` array.
 * `defineModule()` no longer stamps a path, so this is the only source of one.
 */
export type NormalisedEntry =
    | { kind: "registry"; name: string; options: Record<string, unknown> }
    | { kind: "source"; config: ModuleConfig; configPath: string; options: Record<string, unknown> }

function options(entry: ModuleEntry): Record<string, unknown> {
    if (Array.isArray(entry)) {
        const [, opts] = entry as [unknown, Record<string, unknown>]
        return opts ?? {}
    }
    return {}
}

function payload(entry: ModuleEntry): string | ModuleConfig {
    if (Array.isArray(entry)) return (entry as [string | ModuleConfig, unknown])[0]
    return entry as string | ModuleConfig
}

/**
 * Flatten entries, expanding sub-modules declared inside source configs.
 * Depth-first, sub before parent (dependencies available before the parent
 * boots).
 *
 * DEDUPE APPLIES TO DEPENDENCIES, NOT TO DECLARATIONS. Two modules that each
 * depend on `@axon/fs` must yield one fs — that is what the dedupe is for,
 * and it still holds. But an agent listing the same module twice at the TOP
 * LEVEL is stating intent: two screens is two capture feeds, two cameras is
 * two eyes. Collapsing those silently dropped the second one and gave no
 * indication why the second monitor never appeared.
 *
 * So: a repeated dependency collapses, a repeated declaration does not.
 * Nobody writes the same module twice at the top level by accident.
 *
 * The platform deliberately does NOT invent an identity for the copies. What
 * distinguishes two screens is the output name, and only the module knows
 * that — so every instance's options reach the module's plugin (via
 * `axon.modules.all()`) and the module derives its own channels from them.
 *
 * Source paths arrive positionally for the TOP-LEVEL entries. A nested source
 * module's imports live in its OWN module.config.ts, so its children's paths
 * are resolved lazily from that file when we descend into it.
 */
export async function flatten(entries: ModuleEntry[], modulePaths: ResolvedModulePath[]): Promise<NormalisedEntry[]> {
    const seen = new Set<string>()
    const result: NormalisedEntry[] = []

    /**
     * `depth > 0` means we are walking a module's declared dependencies,
     * where a repeat is redundancy. At depth 0 it is the agent's own list,
     * where a repeat is a request for another instance.
     */
    async function walk(list: ModuleEntry[], paths: ResolvedModulePath[], depth = 0) {
        for (let i = 0; i < list.length; i++) {
            const entry = list[i]!
            const resolved = paths[i]
            const raw = payload(entry)
            const opts = options(entry)

            // Registry: a bare string entry, OR an imported config whose
            // specifier resolved to a node_modules package (a registry module
            // reached by importing its config rather than naming it).
            if (typeof raw === "string") {
                if (depth > 0 && seen.has(raw)) continue
                seen.add(raw)
                result.push({ kind: "registry", name: raw, options: opts })
                continue
            }
            if (resolved?.kind === "registry") {
                if (depth > 0 && seen.has(resolved.name)) continue
                seen.add(resolved.name)
                result.push({ kind: "registry", name: resolved.name, options: opts })
                continue
            }

            // Source: an imported (or inline) ModuleConfig whose specifier is
            // relative. Its path is the statically-resolved configPath; an
            // unresolved entry is dropped here and surfaced as a warning by
            // Modules().
            const config = raw
            const configPath = resolved?.kind === "source" ? resolved.configPath : undefined
            if (!configPath) continue

            // Descend into this source module's own declared sub-modules,
            // resolving THEIR paths from this module.config.ts.
            if (config.modules?.length) {
                const childPaths = await resolveModulePaths(configPath)
                await walk(config.modules, childPaths, depth + 1)
            }

            if (depth > 0 && seen.has(configPath)) continue
            seen.add(configPath)
            result.push({ kind: "source", config, configPath, options: opts })
        }
    }

    await walk(entries, modulePaths)
    return result
}

/** The directory a source entry's module.config.ts lives in. */
export function sourceRoot(entry: Extract<NormalisedEntry, { kind: "source" }>): string {
    return dirname(entry.configPath)
}
