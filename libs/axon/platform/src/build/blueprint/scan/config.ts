import { join } from "node:path"
import { AsyncLocalStorage } from "node:async_hooks"
import { defineModule, definePrompt } from "@arcforge/types"
import { defineCognet } from "@arcforge/cognet"
import type { AxonConfig, ModuleEntry } from "@arcforge/types"
import { Axon, Ollama, Codex, OpenRouter, HuggingFace, Mock } from "@arcforge/engines"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { resolveModulePaths, type ResolvedModulePath } from "./moduleImports"
import { resolveCognetPath } from "./cognetImports"
import type { ResolvedDeclaration } from "./configImports"

/**
 * Config — loads and evaluates axon.config.ts. The ONE place in the
 * blueprint pipeline that executes user code; everything else is static
 * analysis and filesystem walking.
 *
 * A broken config THROWS. A missing or unreadable config is not a degraded
 * agent — it is no agent. Scanners warn; config fails loudly.
 */

export type LoadedConfig = {
    /**
     * The directory the config was loaded from.
     *
     * Carried rather than re-passed alongside, because some declarations are
     * made by the FILESYSTEM rather than by the config object — an inline
     * `cognet/` folder is a declaration with nothing written in the config at
     * all. A resolver handed only `value` cannot see those, and making every
     * caller remember to pass the root beside the config is how one of them
     * eventually doesn't.
     */
    root: string
    /** The object passed to defineAgent(). */
    value: AxonConfig
    /** Declared module entries, raw — Modules() normalises and flattens. */
    modules: ModuleEntry[]
    /**
     * Statically-resolved source path for each entry in `modules`, by position.
     * `modulePaths[i]` corresponds to `modules[i]`. A source module carries its
     * absolute `module.config.ts` path here; a registry string carries its name;
     * an entry whose import cannot be resolved carries the reason. This is the
     * ONLY source of a source module's path — `defineModule()` no longer stamps
     * one.
     */
    modulePaths: ResolvedModulePath[]
    /**
     * Statically-resolved origin of the config's `cognet:` entry, or null when
     * the field is absent (the agent declared no brain and tracks the registry
     * default). A source cognet carries its absolute `cognet.config.ts` path
     * here — the only place it exists, since `defineCognet()` stamps nothing.
     */
    cognetPath: ResolvedDeclaration | null
}

type ConfigEvaluation = {
    capture(config: AxonConfig): void
}

const CONFIG_EVALUATION = Symbol.for("axon.config.evaluation")
const evaluationStorage = (() => {
    const shared = globalThis as typeof globalThis & {
        [CONFIG_EVALUATION]?: AsyncLocalStorage<ConfigEvaluation>
    }
    return shared[CONFIG_EVALUATION] ??= new AsyncLocalStorage<ConfigEvaluation>()
})()

/**
 * Synchronous fallback register for the single active evaluation.
 *
 * AsyncLocalStorage is the primary mechanism, but on some Bun versions the
 * ALS context does NOT propagate into a dynamic import()'s module
 * evaluation — so getStore() returns undefined inside the config's
 * synchronous top-level defineAgent() call, and a freshly-scaffolded agent
 * fails its very first boot with "defineAgent() called outside config
 * evaluation" (AX-BLUEPRINT-004).
 *
 * A config module evaluates synchronously as one atomic unit, so as long as
 * only ONE evaluation is in flight at a time, `current` is unambiguous — the
 * defineAgent() call that runs belongs to it. Concurrency is handled by the
 * lock below (evaluations are serialized), not by a stack: a stack would
 * cross-capture, because Bun schedules concurrent import()s and only then
 * runs their synchronous evaluations back-to-back. Held on globalThis so
 * every module copy sees the same current/lock.
 */
const CONFIG_EVALUATION_STATE = Symbol.for("axon.config.evaluation.state")
const state = (() => {
    const shared = globalThis as typeof globalThis & {
        [CONFIG_EVALUATION_STATE]?: { current: ConfigEvaluation | null; lock: Promise<void> }
    }
    return shared[CONFIG_EVALUATION_STATE] ??= { current: null, lock: Promise.resolve() }
})()

/**
 * Config files are ordinary modules and therefore share one global object.
 * Install their authoring API once; the active capture is resolved per call.
 */
function installAuthoringGlobals(): void {
    const g = globalThis as Record<string, unknown>
    g.defineAgent = (config: AxonConfig) => {
        // ALS first (correct even under deep async), the serialized `current`
        // as the fallback for runtimes that drop ALS across import() eval.
        const evaluation = evaluationStorage.getStore() ?? state.current
        if (!evaluation) throw err("CONFIG_EVALUATION_ESCAPED")
        evaluation.capture(config)
        return config
    }
    g.defineModule ??= defineModule
    // A config that imports a source cognet evaluates that cognet.config.ts
    // in this same context, so its defineCognet() call must resolve here.
    // Pure identity, same as defineModule — the real authoring surface is the
    // one @arcforge/cognet installs inside a compiled brain.
    g.defineCognet ??= defineCognet
    g.definePrompt ??= definePrompt
    g.defineArgs ??= () => ({})
    g.defineProps ??= () => ({})
    // Provider factories — what `providers:` takes, in an agent config and a
    // profile config alike. These names were the ENGINE constructors until
    // `engine:` was removed; one name, one meaning again.
    // `??=` deliberately: an embedding host may have installed its own, and
    // the AUTHORITATIVE binding for the duration of an evaluation is applied
    // by withProviderGlobals() below rather than trusted from module load.
    g.Axon ??= Axon
    g.Ollama ??= Ollama
    g.Codex ??= Codex
    g.OpenRouter ??= OpenRouter
    g.HuggingFace ??= HuggingFace
    g.Mock ??= Mock
}

/**
 * Run `body` with the provider factories bound, then put back whatever was
 * there before.
 *
 * `Axon` is a CONTESTED global name. A `*.axon.ts` script run by `axon exec`
 * has `Axon()` bound to the agent-booting factory for the whole run — and
 * booting an agent evaluates axon.config.ts and profile.config.ts, both of
 * which call `Axon()` meaning the PROVIDER factory. Under `??=` at module
 * load the script's binding was already present, so the provider factory was
 * never installed and `providers: [Axon()]` silently produced `{}` instead of
 * `{ provider: "axon" }` — surfacing much later as
 * `PROVIDER_UNKNOWN: "undefined"` from a boot that looked unrelated.
 *
 * Binding unconditionally around the evaluation is what makes the two
 * meanings coexist: inside a config file the name is always the provider
 * factory, and the script's binding is restored the moment the file is read.
 * Safe because both callers already serialize evaluation behind a lock, so
 * these writes never overlap another evaluation.
 */
export async function withProviderGlobals<T>(body: () => Promise<T>): Promise<T> {
    const g = globalThis as Record<string, unknown>
    const factories = { Axon, Ollama, Codex, OpenRouter, HuggingFace, Mock }
    const previous = Object.fromEntries(Object.keys(factories).map(name => [name, g[name]]))
    Object.assign(g, factories)
    try {
        return await body()
    } finally {
        Object.assign(g, previous)
    }
}

installAuthoringGlobals()

export async function Config(root: string): Promise<LoadedConfig> {
    const configPath = join(root, "axon.config.ts")
    if (!fsx.exists(configPath)) {
        throw err("CONFIG_NOT_FOUND", { context: { root } })
    }

    let captured: AxonConfig | null = null
    const evaluation: ConfigEvaluation = { capture: config => { captured = config } }

    // Serialize evaluations so the synchronous `current` fallback is
    // unambiguous (see state above). Chain onto the shared lock; the release
    // is published before we start so the next caller waits on us.
    let release!: () => void
    const previous = state.lock
    state.lock = new Promise<void>(resolve => { release = resolve })
    await previous

    try {
        state.current = evaluation
        // Cache-bust so watch-mode re-runs pick up edits. Date.now() alone
        // collides trivially — repeated calls in the same tick share a
        // millisecond, so Bun's module cache would silently serve a stale
        // import and skip re-invoking defineAgent(). randomUUID() is unique
        // per call regardless of timing.
        //
        // Registered on both the ALS and the serialized `current`: the
        // config's top-level defineAgent() reads whichever is populated (see
        // installAuthoringGlobals) — covering runtimes that drop ALS context
        // crossing into a dynamic import()'s module evaluation.
        try {
            await withProviderGlobals(() =>
                evaluationStorage.run(
                    evaluation,
                    // A BARE PATH, deliberately — not pathToFileURL().
                    //
                    // The module loaders elsewhere convert first, because a
                    // query appended to a bare path makes the runtime read the
                    // whole string as a URL and resolve the module's own bare
                    // specifiers against it (see core/src/modules/load.ts).
                    // That does not apply here: an agent config imports nothing
                    // from node_modules, and converting BREAKS the thing this
                    // call depends on — the evaluationStorage ALS context has
                    // to survive into the dynamic import's module evaluation so
                    // the config's top-level defineAgent() can register. A
                    // file:// URL loses it, and the config then evaluates
                    // without ever calling defineAgent().
                    () => import(`${configPath}?t=${crypto.randomUUID()}`),
                ),
            )
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message : String(cause)
            throw err("CONFIG_LOAD_FAILED", { detail: `${configPath} — ${reason}`, context: { configPath }, cause })
        }

        if (!captured) {
            throw err("CONFIG_INVALID", { detail: `${configPath} did not call defineAgent()`, context: { configPath } })
        }

        const value: AxonConfig = captured
        return {
            root,
            value,
            modules: (value.modules ?? []) as ModuleEntry[],
            modulePaths: await resolveModulePaths(configPath),
            cognetPath: await resolveCognetPath(configPath),
        }
    } finally {
        state.current = null
        release()
    }
}
