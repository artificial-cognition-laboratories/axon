import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"
import { readFile } from "node:fs/promises"
import type { AxonModule, ModuleConfig, ModuleOptionSchema } from "@arcforge/types"
import { err } from "@arcforge/err"

/** A module's config imported and validated, ready to run setup(). */
export type LoadedModule = {
    module: AxonModule
    config: ModuleConfig
    /** SHA-256 of the config file bytes — the determinism fingerprint. */
    configHash: string
    /** Options validated against the module's schema, with defaults applied. */
    options: Record<string, unknown>
}

/**
 * Import a module's module.config.ts by its blueprint-resolved `configPath`
 * and validate its declared options. A module that cannot import, or whose
 * options violate its schema, fails the whole boot — the runtime never runs a
 * partially-wired agent (Hard Invariant #1, #6).
 *
 * The config is re-imported per boot (cache-busted) so a hot-reload picks up
 * edits; the content hash records exactly which bytes ran, so two boots of the
 * same blueprint are provably the same wiring.
 */
export async function loadModule(module: AxonModule): Promise<LoadedModule> {
    const bytes = await readConfigBytes(module.configPath)
    const configHash = createHash("sha256").update(bytes).digest("hex")

    let config: ModuleConfig
    try {
        // Cache-bust so watch-mode reloads re-evaluate. randomUUID (not a
        // timestamp) — repeated imports in one millisecond would otherwise
        // share Bun's module cache and silently serve stale bytes.
        //
        // pathToFileURL FIRST. Appending a query to a bare filesystem path
        // makes the runtime read the whole string as a URL, and a module
        // imported by URL resolves its own bare specifiers against that URL
        // rather than by walking node_modules from its directory. A module
        // importing only relative paths survived that; one importing a real
        // dependency (`discord.js`) failed with "Cannot find package" naming
        // the cache-busted path — the query string was the tell.
        const url = `${pathToFileURL(module.configPath).href}?t=${crypto.randomUUID()}`
        const imported = (await import(url)) as { default?: ModuleConfig }
        if (!imported.default || typeof imported.default !== "object") {
            throw new Error("module.config.ts has no default export")
        }
        config = imported.default
    } catch (cause) {
        throw err("MODULE_CONFIG_LOAD_FAILED", {
            detail: `${module.name} — ${cause instanceof Error ? cause.message : String(cause)}`,
            context: { name: module.name, configPath: module.configPath },
            cause,
        })
    }

    const options = validateOptions(module)
    return { module, config, configHash, options }
}

async function readConfigBytes(configPath: string): Promise<Buffer> {
    try {
        return await readFile(configPath)
    } catch (cause) {
        throw err("MODULE_CONFIG_LOAD_FAILED", {
            detail: `cannot read ${configPath}`,
            context: { configPath },
            cause,
        })
    }
}

/**
 * Validate the agent-supplied options against the module's schema and apply
 * declared defaults.
 *
 * Takes the blueprint's module entry alone, deliberately: the schema there
 * was AST-scraped at scan time and is the validation authority. The imported
 * config drives behaviour only and is never re-read for options, so the two
 * cannot disagree about what a module accepts.
 */
function validateOptions(module: AxonModule): Record<string, unknown> {
    const supplied = module.options ?? {}
    const schema = module.optionsSchema ?? {}
    const resolved: Record<string, unknown> = {}

    for (const [key, spec] of Object.entries(schema)) {
        const value = supplied[key]

        if (value === undefined) {
            if (spec.default !== undefined) resolved[key] = spec.default
            else if (spec.required) {
                throw err("MODULE_OPTIONS_INVALID", {
                    detail: `module "${module.name}" requires option "${key}"`,
                    context: { name: module.name, option: key },
                })
            }
            continue
        }

        if (!typeMatches(value, spec)) {
            throw err("MODULE_OPTIONS_INVALID", {
                detail: `module "${module.name}" option "${key}" expected ${spec.type}, got ${typeof value}`,
                context: { name: module.name, option: key, expected: spec.type, actual: typeof value },
            })
        }
        resolved[key] = value
    }

    return resolved
}

function typeMatches(value: unknown, spec: ModuleOptionSchema): boolean {
    if (spec.type === "string") return typeof value === "string"
    if (spec.type === "number") return typeof value === "number"
    if (spec.type === "boolean") return typeof value === "boolean"
    return false
}
