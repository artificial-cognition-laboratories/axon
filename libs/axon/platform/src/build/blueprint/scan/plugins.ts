import { basename, join } from "node:path"
import { defineAxonPlugin } from "@arcforge/types"
import type { AxonPlugin } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"

/**
 * Plugin files use the ambient `defineAxonPlugin` global — agent authors never
 * import it, same convention as route files and defineEventHandler. Install
 * the real implementation before importing plugin files (idempotent).
 */
function installPluginGlobals(): void {
    const g = globalThis as Record<string, unknown>
    g.defineAxonPlugin ??= defineAxonPlugin
}

/**
 * Plugins — server/plugins/ of ONE root. Each file default-exports a
 * defineAxonPlugin() result; the plugin runs once at server boot, after
 * middleware and before routes, and receives the runtime's axon handle to
 * subscribe to hooks and wire behaviour.
 *
 * Module plugins come from Modules() running this scanner per module root,
 * exactly as it does for routes — a module ships its own server/plugins/ and
 * they merge into the same blueprint.server.plugins list, origin-blind.
 *
 * This scanner IMPORTS each plugin file to resolve its fn — the blueprint
 * contract requires resolved values so the runtime boots as-is and never
 * touches the filesystem. A file that fails to import or lacks a default
 * export is a warning, not a plugin.
 */
/**
 * Whether a file the author wrote that cannot be READ is fatal.
 *
 * True for an agent's own source: the agent is defined by what its author
 * wrote, so silently running a subset of it produces an agent nobody asked
 * for. Invalid state, and invalid states crash.
 *
 * False for a MODULE's, and that is the whole distinction: an agent that
 * installed a broken module is not an invalid agent — it is the agent it was
 * before the install. Crashing the runtime over one dependency leaves the user
 * unable to boot the terminal they need in order to remove it.
 *
 * Degrading was previously rejected because a warning "reached nobody at
 * runtime" — true then, since build:warning classified as debug and was hidden
 * at default verbosity. It is now info-level and renders as its own card, and
 * a module's failure additionally reaches the MODEL through scope.unavailable.
 *
 * Defaults to true: a caller that has not thought about it gets the strict
 * behaviour, and only the module scanner opts out.
 */
export async function Plugins(root: string, opts: { required?: boolean } = {}): Promise<Scanned<AxonPlugin>> {
    const entries: AxonPlugin[] = []
    const warnings: Scanned<AxonPlugin>["warnings"] = []

    installPluginGlobals()

    for (const { absPath, relPath } of await fsx.walk(join(root, "server", "plugins"))) {
        if (!relPath.endsWith(".ts") || relPath.endsWith(".test.ts")) continue

        try {
            const mod = (await import(absPath)) as { default?: unknown }
            const plugin = mod.default as AxonPlugin | undefined
            if (!plugin || typeof plugin.fn !== "function") {
                warnings.push({ domain: "plugins", error: `${absPath} has no default-export defineAxonPlugin() — skipped` })
                continue
            }
            // The filename names what the plugin wires ("discord"), which reads
            // better in boot errors than defineAxonPlugin's generic "plugin"
            // fallback for an anonymous arrow. Prefer it; keep a named fn's own
            // name only when it's more specific than the fallback.
            const named = plugin.name && plugin.name !== "plugin" ? plugin.name : basename(relPath, ".ts")
            entries.push({ name: named, fn: plugin.fn })
        } catch (error) {
            // Plugins wire server behaviour at boot; one silently missing means
            // the agent runs without behaviour its author declared.
            const failure = err("PLUGIN_LOAD_FAILED", {
                detail: `${absPath} — ${error instanceof Error ? error.message : String(error)}`,
                context: { file: absPath },
                cause: error,
            })
            // Strict for an agent's own files, degraded for a module's.
            // Per FILE: one unreadable script skips that script, never the
            // rest of the directory beside it.
            if (opts.required !== false) throw failure
            warnings.push({ domain: "plugins", error: failure.message, cause: failure })
            continue
        }
    }

    return { entries, warnings }
}
