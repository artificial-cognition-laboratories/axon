import { readFile } from "node:fs/promises"
import { err } from "@arcforge/err"
import type { vstr as Vstr } from "@arcforge/vstr"
import { AxonBlueprint, type AxonPrompt } from "@arcforge/types"
import { promptContext } from "./context"

/**
 * `@arcforge/vstr` carries the whole Vue toolchain (@vue/compiler-sfc,
 * runtime-core, server-renderer, turndown) — ~280ms of module evaluation, paid
 * at IMPORT time by anything that reached the runtime. Only .vue prompts need
 * it, so an agent with none, and every request that renders a static prompt,
 * was paying for a compiler it never called.
 *
 * Loaded on first render and memoised: the cost moves to the first .vue
 * render and is never paid twice.
 */
let vstrModule: Promise<{ vstr: typeof Vstr }> | null = null
function loadVstr(): Promise<{ vstr: typeof Vstr }> {
    vstrModule ??= import("@arcforge/vstr")
    return vstrModule
}


type PromptOpts = {
    blueprint: AxonBlueprint
}

/**
 * Renders a prompt by name. Static .md is read as-is; dynamic .vue renders
 * through Vuedown with the given props. Fs is always available at runtime
 * (GCS FUSE mount in prod), so rendering happens live, off the source path —
 * no pre-compiled render functions, no CLI-side rendering step.
 */
export function Prompt(opts: PromptOpts) {
    async function render(name: string, props?: Record<string, unknown>) {
        const entry = opts.blueprint.prompts.find(p => p.name === name)
        if (!entry) throw err("PROMPT_NOT_FOUND", { context: { name } })
        return renderEntry(entry, props)
    }

    /**
     * Render a prompt this agent does not declare.
     *
     * The scope is still this agent's — `promptContext` below hands the
     * template the live `axon` handle and the agent's own resolved env, which
     * is the whole reason rendering belongs in the runtime. What it does NOT
     * need is a blueprint entry: a prompt is content, addressed by an absolute
     * path, and the only thing installing one ever bought was getting that
     * path into `blueprint.prompts`. Cached prompts (~/.axon/cache/prompts)
     * come through here instead of being installed into the agent.
     */
    async function renderEntry(entry: AxonPrompt, props?: Record<string, unknown>) {
        if (!entry.filePath) throw err("PROMPT_FILE_NOT_FOUND", { context: { path: entry.filePath ?? "" } })
        const name = entry.name

        if (entry.kind === "static") {
            return await readFile(entry.filePath, "utf-8")
        }

        // vstr is a generic tool (no @axon/err dependency) — it throws a plain
        // Error on a malformed SFC or a render throw. Wrap it here, at the
        // boundary, into the structured code so it renders as a proper AxonError
        // in chat instead of a raw string.
        try {
            return await (await loadVstr()).vstr(entry.filePath, {
                context: promptContext(),
                // Resolved at scan time and carried on the entry. Without
                // these, a prompt composing <Identity /> cannot resolve the
                // tag and the whole render throws — components are inlined
                // fragments, so a prompt that uses one is unrenderable
                // without them.
                ...(entry.components ? { components: entry.components } : {}),
            }).render(props)
        } catch (cause) {
            throw err("PROMPT_RENDER_FAILED", { cause, context: { name, path: entry.filePath } })
        }
    }

    return {
        render: render,

        /** Render a prompt entry this agent doesn't declare — a cached registry prompt. */
        renderEntry: renderEntry,

        /** Every prompt declared in the blueprint — name + kind, for enumeration (axon.prompts.list()). */
        list() {
            return opts.blueprint.prompts
        },
    }
}
