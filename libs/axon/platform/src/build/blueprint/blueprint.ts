import { createHash } from "node:crypto"
import { join } from "node:path"
import type { AxonPartialBlueprint, EngineRequirements } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../utils/fs"
import { merge } from "./collisions"
import { Config } from "./scan/config"
import { Modules } from "./modules"
import { Boot } from "./scan/boot"
import { Plugins } from "./scan/plugins"
import { Prompts } from "./scan/prompts"
import { Knowledge } from "./scan/knowledge"
import { Routes } from "./scan/routes"
import { Middleware } from "./scan/middleware"
import { Scripts } from "./scan/scripts"
import { Tools } from "./scan/tools"
import { Cognet, cognetSourceOf, readCognetModels, readCognetEngines, type CognetT } from "./cognet"
import { Models } from "../project/models"
import { Frame } from "../frame"
import type { LoadedConfig } from "./scan/config"
import type { ScanWarning } from "./types"

type BlueprintOpts = {
    /** Agent root — the directory containing axon.config.ts. */
    root: string
}

export type BlueprintResult = {
    blueprint: AxonPartialBlueprint
    warnings: ScanWarning[]
}

/**
 * Blueprint — turns an agent directory into the AxonPartialBlueprint that
 * core's normalizer accepts. Pure composition: Config loads the authored
 * truth (throws when broken), scanners discover the surfaces (warn when
 * degraded), Modules runs the same scanners per module root, collisions
 * merge with agent-wins precedence.
 *
 * Knows a root directory — not projects, not auth, not deployment.
 */
export function Blueprint(opts: BlueprintOpts) {
    const root = opts.root
    const cognet = Cognet({ root: root })

    let current: AxonPartialBlueprint | null = null

    return {
        get current(): AxonPartialBlueprint {
            if (!current) throw err("BLUEPRINT_NOT_LOADED")
            return current
        },

        /** The brain toolchain for this root — a caller that watches its source needs sourceDir(). */
        cognet: cognet,

        /**
         * Scan the directory into an AxonPartialBlueprint.
         *
         * `compile` recompiles the brain first. Off by default: a plain read
         * (typegen, a status view) must not spawn a bundler. On for anything
         * that will BOOT the result — prepare, a dev reload — because the scan
         * reads the manifest compilation writes, so skipping it there silently
         * yields the previous brain.
         */
        async load(loadOpts: {
            compile?: boolean
            /**
             * Resolved model paths — local name → absolute path.
             *
             * Optional because the blueprint resolves them itself when not
             * given: `axon dev` boots through a path that never ran prepare's
             * resolution, so requiring the caller to supply them meant the
             * runtime silently handed the brain an empty map. Prepare still
             * passes them, since it has already done the work and a second
             * resolve would be wasted.
             *
             * Resolution here is cache-only in practice — prepare fetched and
             * verified anything missing, and a boot that had to download would
             * be a boot that should have failed at prepare.
             */
            models?: Readonly<Record<string, string>>
            /**
             * The machine-wide policy CEILING, from the profile that owns this
             * agent. Every capability an agent declares is bounded by it, and
             * an agent can only ever narrow within it.
             *
             * Supplied by the caller rather than read here, for the same
             * reason `models` can be: this module knows a root directory, not
             * profiles, not auth, not deployment. Reading a profile would give
             * it an opinion about which user is running — and a deployment,
             * which has no profile at all, would need that opinion to be
             * conditional. The caller knows; this carries.
             *
             * Absent means no ceiling, which is the honest state for a
             * deployment and for `axon run` outside a profile.
             */
            profilePolicy?: AxonPartialBlueprint["profilePolicy"]
            /**
             * The inference sources the owning profile declares.
             *
             * Carried, never read here, for exactly the reason above: this
             * module knows a directory, not which user is running. A blueprint
             * travels, and a deployment has no profile at all — so baking one
             * machine's Ollama daemon in would describe a localhost that is not
             * there.
             */
            profileProviders?: AxonPartialBlueprint["profileProviders"]
        } = {}): Promise<BlueprintResult> {
            const warnings: ScanWarning[] = []

            // Authored truth — a broken config is no agent. Throws.
            const config = await Config(root)

            // `engine:` is deprecated and READ BY NOTHING. Warn rather than
            // throw for the window: an agent carrying it already boots on the
            // profile pool, so failing now would break working agents to tell
            // them about a field that was being ignored anyway. The warning is
            // the only signal an author gets that their declared model is not
            // the one running.
            if ("engine" in config.value && config.value.engine !== undefined) {
                const cause = err("CONFIG_ENGINE_DEPRECATED", { context: { root } })
                warnings.push({ domain: "config", error: cause.message, cause })
            }

            // Before the scan, never after: Cognet.read() below reads exactly
            // what this writes.
            if (loadOpts.compile) await cognet.compile(cognetSourceOf(config))

            // Agent surfaces + modules, in parallel.
            const [prompts, scripts, tools, routes, plugins, middleware, knowledge, boot, modules, brain] = await Promise.all([
                Prompts(root),
                Scripts(root),
                Tools(root),
                Routes(root),
                Plugins(root),
                Middleware(root),
                Knowledge(root),
                Boot(root),
                Modules({ root, declared: config.modules, modulePaths: config.modulePaths }),
                cognet.read(),
            ])
            for (const scanned of [prompts, scripts, tools, routes, plugins, middleware, knowledge]) warnings.push(...scanned.warnings)
            warnings.push(...boot.warnings, ...modules.warnings, ...brain.warnings)

            // Merge module surfaces under agent-wins precedence.
            const groups = modules.surfaces.map(s => ({ owner: s.name, entries: s }))
            const mergedPrompts = merge(
                "prompts",
                prompts.entries,
                groups.map(g => ({ owner: g.owner, entries: g.entries.prompts })),
            )
            const mergedScripts = merge("scripts", scripts.entries, groups.map(g => ({ owner: g.owner, entries: g.entries.scripts })))
            const mergedTools = merge("tools", tools.entries, groups.map(g => ({ owner: g.owner, entries: g.entries.tools })))
            warnings.push(...mergedPrompts.warnings, ...mergedScripts.warnings, ...mergedTools.warnings)

            /**
             * Knowledge appends rather than merging, because a module's
             * entries were namespaced by the scanner that found them —
             * `@axon/docs/agent.md` cannot collide with the agent's own
             * `agent.md`, so there is no precedence question to resolve.
             *
             * That is the opposite call from prompts and tools, which share a
             * flat namespace and need agent-wins. Here the collision was
             * designed out instead of adjudicated: two corpora on the same
             * subject is the normal case, and one silently shadowing the other
             * would be the model told it can read a file it never gets.
             */
            const mergedKnowledge = [...knowledge.entries, ...modules.surfaces.flatMap(s => s.knowledge)]

            // Module routes append after agent routes — server mounts first-wins.
            const moduleRoutes = modules.surfaces.flatMap(s => s.routes)

            // Module plugins run after agent plugins, in module declaration
            // order — same shape as routes: one merged, origin-blind list the
            // server applies.
            const modulePlugins = modules.surfaces.flatMap(s => s.plugins)

            // Module middleware runs AFTER the agent's own, in module
            // declaration order. The agent author's gate goes first: a module
            // cannot slip a handler ahead of an auth check the agent wrote,
            // and cannot short-circuit a request before that check runs.
            const moduleMiddleware = modules.surfaces.flatMap(s => s.middleware)

            // Weights: whatever the caller resolved, or resolve them here.
            // A brain that declared models and received none is broken in a
            // way that only shows up at first inference.
            const models = loadOpts.models ?? await resolveDeclaredModels(cognet, config)

            // The roles this brain needs, read from its own config at build
            // time so the runtime can resolve them BEFORE loading the bundle.
            // A required role nothing can fill has to stop the boot, and a
            // brain that has already loaded is one that will reach for a
            // missing engine mid-wake.
            const engines = await resolveDeclaredEngines(cognet, config)

            const agent = await identity(root)

            const blueprint: AxonPartialBlueprint = {
                agent,
                ...("boot" in boot ? { boot: boot.boot } : {}),
                ...("bootFilePath" in boot ? { bootFilePath: boot.bootFilePath } : {}),
                config: config.value,
                ...(loadOpts.profilePolicy ? { profilePolicy: loadOpts.profilePolicy } : {}),
                ...(loadOpts.profileProviders?.length ? { profileProviders: loadOpts.profileProviders } : {}),
                // absent = unprepared agent; core's normalizer refuses loudly (NO_COGNET)
                ...(brain.entry
                    ? {
                        cognet: {
                            ...brain.entry,
                            ...(Object.keys(models).length ? { models } : {}),
                            ...(Object.keys(engines).length ? { engines } : {}),
                        },
                    }
                    : {}),
                env: await resolvedEnv(root),
                // The supervisor's own credentials — read from the host here,
                // where the CLI legitimately owns process.env, and deliberately
                // NOT merged into `env`, which is what reaches the box.
                hostEnv: hostEnv(),
                tools: mergedTools.merged,
                prompts: mergedPrompts.merged,
                scripts: mergedScripts.merged,
                knowledge: mergedKnowledge,
                modules: modules.modules,
                server: {
                    routes: [...routes.entries, ...moduleRoutes],
                    middleware: [...middleware.entries, ...moduleMiddleware],
                    plugins: [...plugins.entries, ...modulePlugins],
                },
                paths: {
                    root,
                    // Runtime output lives in the frame — see the note on
                    // paths.data in core's AxonBlueprint().
                    data: Frame({ root: root, kind: "agent" }).path("data"),
                },
            }

            current = blueprint
            return { blueprint, warnings }
        },
    }
}

export type BlueprintT = ReturnType<typeof Blueprint>

/**
 * The cognet's declared weights, resolved to absolute paths.
 *
 * Reads the same textual declaration prepare does, then resolves through the
 * shared cache. In the ordinary case everything is already there and this is
 * pure filesystem work — prepare fetched and verified it. A cognet that
 * declares nothing costs one file read.
 */
async function resolveDeclaredModels(
    cognet: CognetT,
    config: LoadedConfig,
): Promise<Readonly<Record<string, string>>> {
    let sourceDir: string
    try {
        sourceDir = cognet.sourceDir(cognetSourceOf(config))
    } catch {
        // No resolvable cognet source — the missing-brain error belongs to
        // the normalizer, not here.
        return {}
    }

    const declared = await readCognetModels(sourceDir)
    if (Object.keys(declared).length === 0) return {}

    const { paths } = await Models().resolve(declared)
    return paths
}

/**
 * The `engines:` a cognet declares, or none.
 *
 * Mirrors resolveDeclaredModels exactly, including its silence when the
 * source cannot be located: a missing brain is the normalizer's error to
 * raise, and reporting it twice from two layers would only make the first
 * one wrong.
 */
async function resolveDeclaredEngines(
    cognet: CognetT,
    config: LoadedConfig,
): Promise<EngineRequirements> {
    try {
        return await readCognetEngines(cognet.sourceDir(cognetSourceOf(config)))
    } catch {
        return {}
    }
}

// ─── Identity ─────────────────────────────────────────────────────────────────

/** name/version from package.json (required — an agent is a package), hash from sources. */
async function identity(root: string) {
    const text = await fsx.readText(join(root, "package.json"))
    if (text === null) {
        throw err("AGENT_INVALID", { detail: `no package.json at ${root}`, context: { root } })
    }
    const pkg = JSON.parse(text) as { name?: string; version?: string }

    return {
        name: pkg.name ?? root.split("/").pop()!,
        version: pkg.version ?? "0.0.0",
        hash: { type: "sha256" as const, value: await sourceHash(root) },
    }
}

/** Deterministic hash over the agent's authored sources. */
async function sourceHash(root: string): Promise<string> {
    const hash = createHash("sha256")

    const files = [
        join(root, "axon.config.ts"),
        join(root, "package.json"),
        ...(await fsx.walk(join(root, "src"))).map(f => f.absPath),
    ]

    for (const file of files.sort()) {
        const content = await fsx.readText(file)
        if (content !== null) {
            hash.update(file)
            hash.update(content)
        }
    }

    return hash.digest("hex")
}

// ─── Environment ──────────────────────────────────────────────────────────────

/**
 * The one place process.env is read. The runtime, capsule, server, and
 * engine all consume blueprint.env — never process.env directly.
 *
 * Agent secrets live in <root>/.env, never in the host shell's env — the
 * TUI process's cwd is not the agent's cwd and must never be assumed to be.
 *
 * ── This is the agent's OWN .env, and nothing else ─────────────────────────
 *
 * It used to be `{ ...process.env }` with the agent's `.env` overlaid on top,
 * which meant the blueprint carried every variable in the invoking shell — and
 * the blueprint is what reaches the agent. An `fs` policy denying `.env` on
 * disk was undone by the same secrets arriving as environment.
 *
 * The host is no longer read here at all. What crosses is decided later, at the
 * one seam that knows the policy (`confine/env.ts`): this file's `.env`, plus
 * whatever `policy.env.allow` explicitly grants. Reading the host here would
 * put the decision above the layer that has the policy to make it.
 */
/**
 * The host variables the SUPERVISOR needs.
 *
 * An explicit list, never a spread. The whole point of the split is that the
 * host's environment stops here; a `{ ...process.env }` on this side would
 * simply move the leak rather than close it, since the supervisor is the thing
 * holding the credentials.
 */
function hostEnv(): Record<string, string> {
    const wanted = [
        "AXON_API_KEY",
        "AXON_CONNECT_TOKEN",
        "AXON_API_BASE",
        "AXON_JWT_PUBLIC_KEY",
        "AXON_HOME",
    ]
    const out: Record<string, string> = {}
    for (const key of wanted) {
        const value = process.env[key]
        if (value !== undefined) out[key] = value
    }
    return out
}

async function resolvedEnv(root: string): Promise<Record<string, string>> {
    const content = await fsx.readText(join(root, ".env"))
    return content ? parseDotenv(content) : {}
}

/** Parse key=value pairs from a .env file's contents. Comments and blank lines skipped. */
function parseDotenv(content: string): Record<string, string> {
    const result: Record<string, string> = {}
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eqIdx = trimmed.indexOf("=")
        if (eqIdx < 0) continue
        const key = trimmed.slice(0, eqIdx).trim()
        let val = trimmed.slice(eqIdx + 1).trim()
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1)
        }
        if (key) result[key] = val
    }
    return result
}
