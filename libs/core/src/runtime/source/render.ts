import { readFile } from "node:fs/promises"
import { err } from "@axon/err"
import { vstr } from "../../../../../tools/vuedown/vstr/src"
import { AxonBlueprint } from "@arcforge/types"
import { promptContext } from "./context"

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
        if (!entry.filePath) throw err("PROMPT_FILE_NOT_FOUND", { context: { path: entry.filePath ?? "" } })

        if (entry.kind === "static") {
            return await readFile(entry.filePath, "utf-8")
        }

        // vstr is a generic tool (no @axon/err dependency) — it throws a plain
        // Error on a malformed SFC or a render throw. Wrap it here, at the
        // boundary, into the structured code so it renders as a proper AxonError
        // in chat instead of a raw string.
        try {
            return await vstr(entry.filePath, {
                context: promptContext(opts.blueprint),
            }).render(props)
        } catch (cause) {
            throw err("PROMPT_RENDER_FAILED", { cause, context: { name, path: entry.filePath } })
        }
    }

    return {
        render: render,

        /** Every prompt declared in the blueprint — name + kind, for enumeration (axon.prompts.list()). */
        list() {
            return opts.blueprint.prompts
        },
    }
}
