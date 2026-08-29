import { extname, join, relative } from "node:path"
import type { vstr as Vstr } from "@arcforge/vstr"
import type { AxonPrompt } from "@arcforge/types"
import { err } from "@arcforge/err"
import { fsx } from "../../../utils/fs"
import { Components } from "./components"
import type { Scanned } from "../types"

/**
 * `@arcforge/vstr` pulls the whole Vue toolchain behind it — @vue/compiler-sfc,
 * runtime-core, server-renderer, turndown — which is ~280ms of module
 * evaluation, and it was paid at IMPORT time by everything that touched the
 * blueprint. That made it the single largest cost in booting an agent, ahead
 * of the scan itself, and an agent with no .vue prompts at all paid it in full.
 *
 * Loaded on first use instead, and memoised so a directory of .vue prompts
 * still evaluates it once. Static-only and empty prompt directories — every
 * `axon` invocation that never introspects a component — never load Vue.
 */
let vstrModule: Promise<{ vstr: typeof Vstr }> | null = null
function loadVstr(): Promise<{ vstr: typeof Vstr }> {
    vstrModule ??= import("@arcforge/vstr")
    return vstrModule
}

/**
 * Prompts — src/prompts/ *.md (static) and *.vue (dynamic, props
 * introspected via vstr). components/ subtrees belong to Components.
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
export async function Prompts(root: string, opts: { prefix?: string; dir?: string; required?: boolean } = {}): Promise<Scanned<AxonPrompt>> {
    // A prompt PACKAGE keeps its prompts at the top level rather than under
    // src/prompts/ — same files, same rules, different depth. `dir` is how
    // that layout reuses this walker instead of duplicating it.
    const promptsDir = opts?.dir ? join(root, opts.dir) : join(root, "src", "prompts")
    const entries: AxonPrompt[] = []
    const warnings: Scanned<AxonPrompt>["warnings"] = []

    // Scanned once per root and carried on each dynamic entry, so the
    // renderer never re-derives this from a file path. Components sit beside
    // the prompts in both layouts — components/ off whichever directory the
    // prompts themselves live in.
    const components = await Components(root, opts?.dir ? { dir: join(opts.dir, "components") } : undefined)
    const componentPaths = Object.fromEntries(components.entries.map(entry => [entry.name, entry.filePath]))
    const hasComponents = components.entries.length > 0

    for (const { absPath, relPath } of await fsx.walk(promptsDir, { skipDirs: ["components"] })) {
        const ext = extname(absPath)
        if (ext !== ".md" && ext !== ".vue") continue

        const name = relative(".", relPath).slice(0, -ext.length).replace(/\\/g, "/")
        const prefixed = opts?.prefix ? `${opts.prefix}:${name}` : name

        try {
            if (ext === ".md") {
                const content = (await fsx.readText(absPath)) ?? ""
                entries.push({
                    name: prefixed,
                    kind: "static",
                    filePath: absPath,
                    ...(firstLine(content) !== undefined ? { description: firstLine(content)! } : {}),
                })
            } else {
                const { vstr } = await loadVstr()
                const props = vstr(absPath).introspect()

                // A template interpolates VALUES. Anything async has to be
                // awaited in `<script setup>` and interpolated by name — see
                // promptContext, which puts the agent's tools in scope
                // precisely so that is possible.
                for (const call of interpolatedCalls((await fsx.readText(absPath)) ?? "")) {
                    warnings.push({
                        domain: "prompts",
                        error: `${prefixed}: \`{{ ${call} }}\` calls a function in the template.`
                            + ` If it returns a promise this renders as "[object Promise]" and the model`
                            + ` receives that verbatim — await it in <script setup> and interpolate the result.`,
                    })
                }
                entries.push({
                    name: prefixed,
                    kind: "dynamic",
                    filePath: absPath,
                    // Static .md has no template, so nothing to compose into.
                    ...(hasComponents ? { components: componentPaths } : {}),
                    ...(props.length > 0
                        ? { props: props.map(p => ({ name: p.name, type: p.type, required: p.required })) }
                        : {}),
                })
            }
        } catch (error) {
            // A prompt that cannot be introspected renders without the inputs it
            // declares, or not at all.
            const failure = err("PROMPT_INTROSPECT_FAILED", {
                detail: `${absPath} — ${error instanceof Error ? error.message : String(error)}`,
                context: { file: absPath },
                cause: error,
            })
            // Strict for an agent's own files, degraded for a module's.
            // Per FILE: one unreadable script skips that script, never the
            // rest of the directory beside it.
            if (opts.required !== false) throw failure
            warnings.push({ domain: "prompts", error: failure.message, cause: failure })
            continue
        }
    }

    return { entries, warnings }
}

/**
 * Calls appearing directly inside a `{{ }}` interpolation.
 *
 * Syntactic on purpose: knowing which names are async would mean carrying the
 * tool scope into the prompt scanner, and the useful signal does not need it.
 * A template can only render a value, so a CALL there is already suspicious —
 * and the async ones are the case that fails silently, reaching the model as
 * "[object Promise]" rather than throwing.
 *
 * Deliberately narrow to avoid crying wolf:
 *   - only `name(` and `ns.name(` heads, so `{{ items.length }}` is quiet
 *   - `$`-prefixed and capitalised heads are skipped (framework helpers,
 *     component references)
 *
 * A warning, never a failure: a synchronous helper called in a template is
 * unusual but legal, and a build that refused it would be wrong.
 */
function interpolatedCalls(source: string): string[] {
    const found: string[] = []
    for (const match of source.matchAll(/\{\{([^}]*)\}\}/g)) {
        const expression = (match[1] ?? "").trim()
        const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/.exec(expression)
        if (!call) continue
        const head = call[1]!
        if (head.startsWith("$") || /^[A-Z]/.test(head)) continue
        found.push(expression)
    }
    return found
}

function firstLine(content: string): string | undefined {
    const lines = content.split("\n").map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) return undefined
    const first = lines[0]!
    return first.startsWith("#") ? first.replace(/^#+\s*/, "") : first
}
