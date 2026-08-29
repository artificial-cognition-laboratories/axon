import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { Frame } from "../../frame"
import type { CognetBlueprint } from "@arcforge/types"
import type { CognetArtifact } from "./bundle"
import type { ScanWarning } from "../types"
import type { ResolvedDeclaration } from "../scan/configImports"
import { bundleCognet } from "./bundle"
import { readManifest } from "./manifest"
import { DEFAULT_COGNET, resolveCognet } from "./resolve"

/** The `sourceDir` the last compile recorded, or null when unavailable. */
function readManifestSourceDir(root: string): string | null {
    try {
        const raw = readFileSync(Frame({ root: root, kind: "agent" }).file("cognet", "manifest.json"), "utf8")
        const parsed = JSON.parse(raw) as { sourceDir?: unknown }
        return typeof parsed.sourceDir === "string" ? parsed.sourceDir : null
    } catch {
        // No manifest, or one written before sourceDir was recorded. Both mean
        // "unknown", which the caller handles — never a guess.
        return null
    }
}

type CognetOpts = {
    /** Agent root — the directory containing axon.config.ts. */
    root: string
}

/**
 * Where a brain comes from — the two forms a declaration resolves to.
 *
 * A registry cognet is installed into node_modules and found by name; a source
 * cognet is a directory on disk. Both end at the same place (a directory
 * bundleCognet() compiles), but only one of them can be looked up, so they must
 * not both be a bare string.
 *
 * A source cognet arrives two ways: an author imports its config from anywhere
 * on disk, or they write one INLINE at `<agent>/cognet/` and declare nothing.
 * Both produce `kind: "source"` — where the directory sits is not a fact the
 * rest of the pipeline should have to know.
 */
export type CognetSource =
    | { kind: "registry"; specifier: string }
    | { kind: "source"; dir: string }

/**
 * The folder an agent writes its own brain in.
 *
 * A cognet here needs no `cognet:` line: the directory existing IS the
 * declaration, the same way `src/tools/` needs no `tools:` list. That is the
 * point of inlining — an agent with a bespoke brain should read as one
 * project, not as two that happen to reference each other.
 */
export const INLINE_COGNET_DIR = "cognet"

/**
 * The inline cognet's directory, if the agent has one.
 *
 * Recognized by its ENTRY, not by a config file: `cognet.config.ts` is
 * optional for an inline brain (identity comes from the agent — see
 * bundleCognet), so requiring it here would make the smallest possible
 * cognet, a lone `cognet/main.ts` holding a `loop()`, invisible to every
 * stage that asks this question.
 */
export function inlineCognetDir(agentRoot: string): string | null {
    const dir = join(agentRoot, INLINE_COGNET_DIR)
    const hasEntry = fsx.isFile(join(dir, "main.ts")) || fsx.isFile(join(dir, "src", "main.ts"))
    return hasEntry ? dir : null
}

/**
 * A loaded config's cognet declaration as a CognetSource.
 *
 * The one place the evaluated value, the statically-resolved path, and the
 * inline `cognet/` folder are reconciled, so no caller has to know that a
 * string means "registry", an object means "look at cognetPath", and a
 * directory on disk means "compile that". Returns undefined when the agent
 * declared nothing at all — it tracks the registry default, which is not the
 * same as declaring it.
 *
 * Declaring BOTH is an error, not a precedence question. An agent has one
 * brain; a `cognet:` line beside a populated `cognet/` folder states two, and
 * every way of resolving that silently is worse than saying so. Picking the
 * explicit one ignores a whole directory of source the author wrote and will
 * keep editing; picking the folder overrules what they typed. Neither is
 * guessable from the outside, so this throws and names both.
 *
 * `unresolved` throws rather than falling back: an author who wrote an import
 * the build cannot follow has a broken config, and quietly compiling @axon/zero
 * instead would hide it behind a brain that runs.
 */
export function cognetSourceOf(config: {
    /** Agent root — how an inline `cognet/` is seen. Carried by LoadedConfig. */
    root: string
    value: { cognet?: unknown }
    cognetPath: ResolvedDeclaration | null
}): CognetSource | undefined {
    const declared = config.value.cognet
    const inline = inlineCognetDir(config.root)

    // Nothing written: the folder speaks for itself, or the agent tracks the
    // registry default.
    if (declared === undefined) {
        return inline ? { kind: "source", dir: inline } : undefined
    }

    if (inline) {
        throw err("COGNET_AMBIGUOUS", {
            detail: `this agent declares cognet: in axon.config.ts AND has an inline cognet at ${inline} — `
                + "an agent has one brain. Remove the cognet: line to use the folder, "
                + "or delete/rename the folder to use the declaration.",
            context: { root: config.root, inline, declared },
        })
    }

    if (typeof declared === "string") {
        return { kind: "registry", specifier: declared }
    }

    // An imported binding — the path is only knowable statically.
    const resolved = config.cognetPath
    if (resolved?.kind === "source") {
        return { kind: "source", dir: dirname(resolved.configPath) }
    }
    if (resolved?.kind === "registry") {
        return { kind: "registry", specifier: resolved.name }
    }

    throw err("COGNET_NOT_FOUND", {
        detail: resolved?.detail
            ?? "cognet: was given a value that is neither a registry name nor a resolvable source import",
    })
}

/**
 * Cognet — the agent's brain, from declared specifier to loadable artifact.
 *
 * Owns the whole toolchain: resolve the specifier to installed source,
 * compile it into .agent/cognet/, and read back the manifest the blueprint
 * carries.
 *
 * Compilation lives HERE, behind load(), because a blueprint is not complete
 * without a compiled brain — scan reads the manifest that compilation writes.
 * That ordering used to be every caller's job to remember: prepare, the dev
 * reload, and the bench preload each called bundleCognet() and then
 * Blueprint.load() on the next line, and a caller that forgot got a silently
 * stale brain rather than an error. Two verbs with a mandatory order are one
 * verb.
 */
export function Cognet(opts: CognetOpts) {
    const root = opts.root

    /**
     * The source the last compile() resolved.
     *
     * A source cognet's directory is only knowable by statically resolving the
     * config's import, which needs the config FILE — and a caller holding just
     * the evaluated blueprint (the dev watcher) has no way back to it. Rather
     * than thread the resolution through every consumer, the toolchain that
     * did the resolving remembers it.
     */
    let compiled: CognetSource | undefined

    /**
     * Where this agent's brain source lives, for a caller that wants to watch
     * or compile it.
     *
     * Takes the config's declared cognet in either form: a registry specifier
     * resolves through node_modules, while an already-resolved source
     * directory is passed straight back. Callers hold `CognetSource` rather
     * than a bare string so the two origins cannot be confused — a source path
     * fed to the registry resolver would fail with a spelling-mistake error.
     *
     * With NO source, an inline `cognet/` is checked before falling back to
     * the registry default. Callers reach this path when they hold a blueprint
     * but not the config it came from (the dev watcher), and for an inline
     * agent the default would be flatly wrong — it would resolve @axon/zero
     * and watch a directory in node_modules while the author edits their own
     * brain and sees nothing reload.
     */
    function sourceDir(source?: CognetSource): string {
        if (source?.kind === "source") return source.dir
        if (!source) {
            const inline = inlineCognetDir(root)
            if (inline) return inline
        }
        return resolveCognet(source?.specifier ?? DEFAULT_COGNET, root)
    }

    return {
        sourceDir: sourceDir,

        /**
         * Compile the declared cognet into .agent/cognet/.
         *
         * Idempotent and content-gated by bundleCognet() itself — an unchanged
         * source recompiles to the same hash and rewrites nothing.
         */
        async compile(source?: CognetSource): Promise<CognetArtifact> {
            compiled = source
            const dir = sourceDir(source)
            return bundleCognet({
                sourceDir: dir,
                agentRoot: root,
                // Compared by path rather than trusting the source's kind: an
                // inline brain can also arrive as an explicit `source` (a
                // watcher re-resolving one), and what relaxes the config
                // requirement is WHERE it lives, not how it was named.
                inline: dir === inlineCognetDir(root),
            })
        },

        /**
         * The source directory of the brain this agent last compiled — what a
         * dev watcher needs in order to rebuild on edit.
         *
         * Read from the manifest the compile WROTE, not from in-memory state:
         * the watcher is built from a different Cognet() instance than the one
         * prepare compiled with, so `compiled` is unset there. It used to fall
         * back to resolving DEFAULT_COGNET, which meant an agent running any
         * other brain failed at boot with "@axon/zero is declared but not
         * present" — naming a cognet nothing had ever declared.
         *
         * Null when nothing has been compiled yet; a caller that cannot watch
         * a brain that does not exist should skip rather than guess.
         */
        get compiledFrom(): string | null {
            if (compiled) return sourceDir(compiled)
            const recorded = readManifestSourceDir(root)
            return recorded && fsx.exists(recorded) ? recorded : null
        },

        /**
         * The compiled brain as the blueprint carries it (path + hash).
         *
         * A missing or dangling manifest is a warning with an absent entry,
         * never a throw: core's normalizer refuses loudly (NO_COGNET) at the
         * one seam that should own that message.
         */
        async read(): Promise<{ entry: CognetBlueprint | null; warnings: ScanWarning[] }> {
            return readManifest(root)
        },
    }
}

export type CognetT = ReturnType<typeof Cognet>
