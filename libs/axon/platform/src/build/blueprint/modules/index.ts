import { basename, join } from "node:path"
import type { AxonKnowledge, AxonMiddleware, AxonModule, AxonPlugin, AxonPrompt, AxonRoute, AxonScript, AxonTool, ModuleEntry } from "@arcforge/types"
import type { ResolvedModulePath } from "../scan/moduleImports"
import { fsx } from "../../../utils/fs"
import { Plugins } from "../scan/plugins"
import { Prompts } from "../scan/prompts"
import { Knowledge } from "../scan/knowledge"
import { Routes } from "../scan/routes"
import { Middleware } from "../scan/middleware"
import { Scripts } from "../scan/scripts"
import { Tools } from "../scan/tools"
import type { ScanWarning } from "../types"
import { flatten, sourceRoot } from "./entries"
import { readMeta } from "./meta"

/**
 * Modules — the one composite scanner. Resolves declared + installed modules
 * and runs the SAME scanners against each module root that run against the
 * agent. Module scanning can never drift from agent scanning because there
 * is no second implementation.
 *
 * Sources, in precedence order:
 * 1. Source modules declared in axon.config.ts (defineModule imports) —
 *    developed in place, win over an installed copy of the same name.
 * 2. Local modules in modules/ that were not explicitly imported.
 * 3. Registry modules declared as strings in axon.config.ts, resolved out
 *    of node_modules where the package manager put them.
 *
 * Declaration is the config, always. A package present in node_modules but
 * absent from axon.config.ts contributes nothing: it may be a transitive
 * dependency of another module, and a transitive dependency must never
 * silently add tools to an agent's surface. This used to work the other
 * way round — anything in the module store was active — which made the
 * agent's tool surface a property of the filesystem rather than of a file
 * the author reads and reviews.
 */

/** One module's discovered surface, attributed for collision reporting. */
export type ModuleSurface = {
    name: string
    prompts: AxonPrompt[]
    /** Already namespaced by module name — see the Knowledge() call below. */
    knowledge: AxonKnowledge[]
    scripts: AxonScript[]
    tools: AxonTool[]
    routes: AxonRoute[]
    plugins: AxonPlugin[]
    middleware: AxonMiddleware[]
}

export type ModulesResult = {
    modules: AxonModule[]
    surfaces: ModuleSurface[]
    warnings: ScanWarning[]
}

export async function Modules(opts: {
    root: string
    declared: ModuleEntry[]
    /** Statically-resolved source paths, positional to `declared`. */
    modulePaths: ResolvedModulePath[]
}): Promise<ModulesResult> {
    const entries = await flatten(opts.declared, opts.modulePaths)
    const modules: AxonModule[] = []
    const surfaces: ModuleSurface[] = []
    const warnings: ScanWarning[] = []
    const claimed = new Set<string>()

    // A declared entry whose import could not be resolved to a file is a
    // silent-no-tools trap — surface it. This is the class of failure that
    // used to happen invisibly when defineModule guessed a path from the stack.
    for (const resolved of opts.modulePaths) {
        if (resolved.kind === "unresolved") {
            warnings.push({ domain: "modules", error: `unresolved module declaration — ${resolved.detail}` })
        }
    }

    // ── 1. Declared source modules ───────────────────────────────────────────
    for (const entry of entries) {
        if (entry.kind !== "source") continue
        const root = sourceRoot(entry)
        const name = await moduleName(root)
        claimed.add(name)
        await scanModule({ root, name, configPath: entry.configPath, options: entry.options, modules, surfaces, warnings })
    }

    // ── 2. Unimported local modules (modules/ directory) ────────────────────
    const modulesDir = join(opts.root, "modules")
    for (const dir of await fsx.list(modulesDir)) {
        if (claimed.has(dir)) continue // source module owns this name

        const declared = entries.find(e => e.kind === "registry" && e.name.split("/").pop() === dir)
        const root = join(modulesDir, dir)
        await scanModule({
            root,
            name: dir,
            configPath: join(root, "module.config.ts"),
            options: declared?.options ?? {},
            modules,
            surfaces,
            warnings,
        })
    }

    // ── 3. Declared registry modules (node_modules/) ─────────────────────────
    for (const entry of entries) {
        if (entry.kind !== "registry") continue

        const root = join(opts.root, "node_modules", ...entry.name.split("/"))
        if (!fsx.exists(root)) {
            warnings.push({
                domain: "modules",
                error: `module "${entry.name}" is declared in axon.config.ts but not installed — run \`axon install\``,
            })
            continue
        }

        const name = await moduleName(root)
        if (claimed.has(name)) {
            // A source module of the same name wins — developing in place
            // beats the installed copy. But the user declared BOTH, so say
            // so: silently dropping a declaration is how an install appears
            // to succeed while contributing nothing.
            warnings.push({
                domain: "modules",
                error: `module "${entry.name}" is also imported from source as "${name}" — the source module is used and the installed copy ignored. Remove one declaration from axon.config.ts.`,
            })
            continue
        }
        claimed.add(name)
        await scanModule({ root, name, configPath: join(root, "module.config.ts"), options: entry.options, modules, surfaces, warnings })
    }

    return { modules, surfaces, warnings }
}

// ─── One module ───────────────────────────────────────────────────────────────

async function scanModule(opts: {
    root: string
    name: string
    /** Absolute path to this module's module.config.ts — carried into the blueprint for boot-time import. */
    configPath: string
    options: Record<string, unknown>
    modules: AxonModule[]
    surfaces: ModuleSurface[]
    warnings: ScanWarning[]
}): Promise<void> {
    const { root, name, configPath } = opts

    if (!fsx.exists(configPath)) {
        opts.warnings.push({ domain: "modules", error: `module "${name}" at ${root} has no module.config.ts — skipped` })
        return
    }

    /**
     * A module listed twice is two INSTANCES, not two copies of its code.
     *
     * Each instance contributes its own AxonModule (so its options reach the
     * runtime), but the module's files are scanned ONCE: a second copy of
     * the same plugin would run the same capture loop twice, each seeing
     * every instance, and produce duplicate channels from a single device.
     * Same for its tools and prompts, which would collide with themselves.
     *
     * The instance-specific part is entirely `options`, and that is what the
     * plugin reads through `axon.modules.all()`.
     */
    const alreadyScanned = opts.surfaces.some(surface => surface.name === name)

    const meta = await readMeta(configPath)

    const [prompts, scripts, tools, routes, plugins, middleware, knowledge] = await Promise.all([
        // Every scanner degrades for a MODULE — see each scanner's `required`.
        // The agent's own source (blueprint.ts) stays strict: it is what the
        // author wrote, and running a subset of it is an agent nobody asked
        // for. A module is a dependency, and a broken one must not cost the
        // user the terminal they need in order to remove it.
        Prompts(root, { required: false }),
        Scripts(root, { required: false }),
        Tools(root, { required: false }),
        Routes(root, { required: false }),
        Plugins(root, { required: false }),
        // Degrades to a BLOCKER, not a skip — a guard that failed to load must
        // never leave its routes unguarded. See scan/middleware.ts.
        Middleware(root, { required: false }),
        // Prefixed with the module's name so its material cannot shadow the
        // agent's own — two corpora on the same subject is the normal case,
        // and a silent shadow would advertise a file the model never gets.
        Knowledge(root, { prefix: name, required: false }),
    ])
    const scanWarnings: string[] = []
    for (const scanned of [prompts, scripts, tools, routes, plugins, middleware, knowledge]) {
        // Tagged on the DOMAIN, not smuggled into the message: the message is
        // the scanner's own sentence and a renderer showing a structured error
        // beside it would otherwise print the module name twice.
        opts.warnings.push(...scanned.warnings.map(w => ({ ...w, domain: `${w.domain}:${name}` })))
        scanWarnings.push(...scanned.warnings.map(w => w.error))
    }

    /**
     * What this module lost, as one sentence for the model.
     *
     * Collected here rather than derived later because this is the only place
     * that knows WHICH module a warning came from — by the time they reach the
     * blueprint's flat list, the association is a string prefix.
     */
    const degraded = scanWarnings.length > 0 ? scanWarnings.join("; ") : undefined

    // Each tool file scanned inside a module stays its own AxonTool — same
    // shape as an agent's own src/tools/*.ts, just re-tagged with this
    // module's origin/modulePath. This is what keeps declaration (typegen,
    // renderScope) and execution (toCapsuleTools, one real file per
    // AxonTool.entryPath) in lockstep: one file in, one namespace out, no
    // collapse step that execution then has to reconstruct or diverge from.
    //
    // KNOWN GAP (see debt.md): `flat` is inherited from Tools(), which sets it
    // for an agent's own src/tools. A module's tools therefore install as
    // top-level globals rather than under the module's name, contradicting the
    // documented `github.*` prefixing. An agent tool and a module tool both
    // exporting `openPr` currently produce two identical declarations in one
    // `declare global` block, and the capsule's Object.assign over flat tools
    // means whichever loads last silently wins. merge() cannot catch it: it
    // dedupes on the TOOL name (the filename), while the collision is between
    // the FUNCTION names inside them.
    //
    // Not simply cleared here: registry modules export one object named after
    // the file (`export const prs = {...}`), which is written for flat
    // placement — namespacing them without changing that convention yields
    // `prs.prs.list()`. Fixing this properly means deciding the module tool
    // namespace (module name vs filename) and migrating the registry with it.
    const moduleTools: AxonTool[] = tools.entries.map(tool => ({
        ...tool,
        origin: "module",
        modulePath: root,
    }))

    if (!alreadyScanned) {
        opts.surfaces.push({
            name,
            prompts: prompts.entries,
            knowledge: knowledge.entries,
            scripts: scripts.entries,
            tools: moduleTools,
            routes: routes.entries,
            plugins: plugins.entries,
            middleware: middleware.entries,
        })
    }

    // Registry identity, when the module ships a package.json. Uninstall and
    // reinstall address a module by its package name — the short `name`
    // above is for namespacing and cannot round-trip to the registry.
    const pkg = await modulePackage(root)

    opts.modules.push({
        name,
        ...(pkg.name ? { packageName: pkg.name } : {}),
        ...(pkg.version ? { version: pkg.version } : {}),
        root,
        configPath,
        automerge: meta.automerge ?? true,
        env: meta.env,
        optionsSchema: meta.optionsSchema,
        prompts: prompts.entries,
        scripts: scripts.entries,
        tools: moduleTools,
        ...(Object.keys(opts.options).length > 0 ? { options: opts.options } : {}),
        ...(fsx.exists(join(root, "server")) ? { serverPath: join(root, "server") } : {}),
        ...(fsx.exists(join(root, "server", "api")) ? { apiPath: join(root, "server", "api") } : {}),
        ...(fsx.exists(join(root, "data", "knowledge")) ? { knowledgePath: join(root, "data", "knowledge") } : {}),
        ...(degraded ? { degraded } : {}),
    })
}

/** package.json name (short form) or directory basename. */
async function moduleName(root: string): Promise<string> {
    const text = await fsx.readText(join(root, "package.json"))
    if (text) {
        const raw = (JSON.parse(text) as { name?: string }).name
        if (raw) return raw.includes("/") ? raw.split("/").pop()! : raw
    }
    return basename(root)
}

/** A module's package.json identity — absent for a bare directory module. */
async function modulePackage(root: string): Promise<{ name?: string; version?: string }> {
    const text = await fsx.readText(join(root, "package.json"))
    if (!text) return {}
    try {
        const { name, version } = JSON.parse(text) as { name?: string; version?: string }
        return { ...(name ? { name } : {}), ...(version ? { version } : {}) }
    } catch {
        // A malformed package.json is the module author's problem, surfaced
        // by the scanners that actually need to read it — identity is
        // optional metadata and must not fail the whole scan.
        return {}
    }
}


