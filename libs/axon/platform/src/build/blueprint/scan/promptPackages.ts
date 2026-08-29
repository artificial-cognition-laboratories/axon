import { join } from "node:path"
import type { AxonPrompt } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import { Prompts } from "./prompts"
import type { Scanned } from "../types"

/**
 * Prompt packages — a published prompt artifact, scanned into prompts.
 *
 * A prompt is content, not a capability: it is fetched into the global cache
 * (~/.axon/cache/prompts/...) and rendered on demand, so no agent installs one
 * or depends on it. Each package contributes every top-level .vue/.md it
 * ships, namespaced by the package:
 *
 *     @cody/eslint-scout  →  "@cody/eslint-scout:scout"
 *                            "@cody/eslint-scout:reconcile"
 *
 * The prefix is what makes a published prompt unable to shadow an agent's own
 * `src/prompts/scout.vue` — they occupy different namespaces by construction
 * rather than by a precedence rule that has to be remembered.
 *
 * A package that declares exactly one prompt named after itself also answers
 * to the bare package name, so `@cody/scout` need not be written
 * `@cody/scout:scout`.
 *
 * Both layouts go through Prompts(): a package authored agent-shaped keeps its
 * src/prompts/, a flat one is scanned with the package root AS the prompts
 * directory. README.md is excluded — it is documentation, not an instruction
 * to run.
 */
export async function scanPromptPackage(packageRoot: string, name: string): Promise<Scanned<AxonPrompt>> {
    const nested = fsx.exists(join(packageRoot, "src", "prompts"))
    const scanned = await Prompts(packageRoot, { prefix: name, ...(nested ? {} : { dir: "." }) })

    const entries = scanned.entries.filter(entry => entry.name !== `${name}:README`)

    // The single-prompt shorthand: @cody/scout shipping scout.vue also
    // answers to the bare package name, so the common case reads as one
    // thing rather than a package with one member.
    const bare = name.split("/").at(-1)
    const self = entries.find(entry => entry.name === `${name}:${bare}`)
    if (self && entries.length === 1) entries.push({ ...self, name })

    return { entries, warnings: scanned.warnings }
}
