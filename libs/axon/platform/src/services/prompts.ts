import type { AxonPrompt } from "@arcforge/types"
import { err } from "@arcforge/err"
import { scanPromptPackage } from "../build/blueprint/scan/promptPackages"
import type { PromptCacheT } from "./registry"

type PromptsOpts = {
    cache: PromptCacheT
}

/**
 * Prompts — published prompts, resolved to something an agent can render.
 *
 * The whole service is two steps: put the artifact on disk (the cache), then
 * scan it into the same `AxonPrompt` entries a declared prompt produces. What
 * comes out is indistinguishable from an agent's own prompt except for where
 * its filePath points — which is exactly the property that lets the runtime
 * render it without the agent ever depending on it.
 *
 * This is deliberately NOT the module installer. A module is code: it links
 * against the runtime, has an ABI, and must live in the agent's own
 * node_modules. A prompt is content that a person picks off a palette, and
 * routing it through an installer bought nothing while costing a tree rewrite,
 * a manifest edit and an agent reload per use.
 */
export function Prompts(opts: PromptsOpts) {
    /**
     * A published prompt's entries, fetching it on first use.
     *
     * Returns every prompt the package ships (a package may carry several),
     * named exactly as the blueprint would name them — "@cody/scout:reconcile",
     * plus the bare "@cody/scout" shorthand for a single-prompt package.
     */
    async function entries(ref: string): Promise<AxonPrompt[]> {
        const { name, root } = await opts.cache.ensure(ref)
        const scanned = await scanPromptPackage(root, name)

        if (scanned.entries.length === 0) {
            throw err("PROMPT_NOT_FOUND", {
                detail: `${name} is published but ships no prompt files`,
                context: { name },
            })
        }

        return scanned.entries
    }

    return {
        entries,

        /**
         * The single entry a bare registry name refers to.
         *
         * A one-prompt package answers to its own name (the shorthand
         * scanPromptPackage adds), so this is the common palette case: the user
         * picked "@axon/tdd" and means the prompt of that name.
         */
        async entry(ref: string): Promise<AxonPrompt> {
            const found = await entries(ref)
            const exact = found.find(entry => entry.name === ref)
            if (exact) return exact

            // A multi-prompt package has no single answer — naming one is the
            // caller's job, and silently picking the first would be a guess.
            if (found.length > 1) {
                throw err("PROMPT_NOT_FOUND", {
                    detail: `${ref} ships ${found.length} prompts — name one of: ${found.map(e => e.name).join(", ")}`,
                    context: { name: ref },
                })
            }

            return found[0]!
        },
    }
}

export type PromptsT = ReturnType<typeof Prompts>
