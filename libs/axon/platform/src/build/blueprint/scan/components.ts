import { join } from "node:path"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"

export type PromptComponent = {
    /** PascalCase name used in templates, e.g. "ScoutingBasics". */
    name: string
    /** Absolute path to the .vue file. */
    filePath: string
}

/**
 * Components — prompt components of ONE root, flat by convention. Not part
 * of the blueprint object: consumed by typegen and by prompt rendering.
 * Cross-root precedence (agent over module) is the caller's merge, same as
 * every other surface.
 *
 * Two layouts, one walker. An agent or module keeps components under
 * src/prompts/components/; a prompt PACKAGE is the folder itself, so its
 * components sit at components/ off the root. `dir` is how the flat layout
 * reuses this rather than duplicating it — the same seam Prompts() already
 * has, and for the same reason.
 */
export async function Components(root: string, opts?: { dir?: string }): Promise<Scanned<PromptComponent>> {
    const dir = opts?.dir ? join(root, opts.dir) : join(root, "src", "prompts", "components")
    const entries: PromptComponent[] = []

    for (const file of await fsx.list(dir)) {
        if (!file.endsWith(".vue")) continue
        entries.push({
            name: pascalCase(file.replace(/\.vue$/, "")),
            filePath: join(dir, file),
        })
    }

    return { entries, warnings: [] }
}

/** "scouting-basics" → "ScoutingBasics" */
function pascalCase(name: string): string {
    return name
        .split("-")
        .map(s => s.charAt(0).toUpperCase() + s.slice(1))
        .join("")
}
