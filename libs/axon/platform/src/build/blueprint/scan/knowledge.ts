import { join } from "node:path"
import { stat } from "node:fs/promises"
import type { AxonKnowledge } from "@arcforge/types"
import { fsx } from "../../../utils/fs"
import type { Scanned } from "../types"

/**
 * How many bytes of a file are read looking for frontmatter.
 *
 * The catalogue must stay cheap to build: reading 200 files in full to
 * extract 200 one-line descriptions would make the scan cost proportional to
 * the corpus rather than to its file count.
 */
const FRONTMATTER_BYTES = 4096

/**
 * Pull a one-line summary out of YAML frontmatter.
 *
 * `description` wins over `title`, and both are read because real corpora are
 * uneven — the Axon docs carry a title on 193 of 194 files and a description
 * on 32. Reading only the richer field leaves most of a good catalogue as
 * bare filenames, which is the difference between a model that can route and
 * one that guesses.
 *
 * Deliberately narrow: two keys, string values, no nesting or multi-line
 * scalars. A YAML dependency would buy nothing for one line, and anything
 * unreadable is simply an entry with no description — ordinary, not an error.
 * A .sqlite file has no frontmatter and is still legitimate knowledge.
 */
function describe(head: string): string {
    if (!head.startsWith("---")) return ""
    const end = head.indexOf("\n---", 3)
    if (end < 0) return ""

    let title = ""
    for (const line of head.slice(3, end).split("\n")) {
        const match = /^\s*(description|title)\s*:\s*(.+?)\s*$/.exec(line)
        if (!match) continue
        const value = match[2]!.replace(/^["'](.*)["']$/, "$1")
        if (match[1] === "description") return value
        title ||= value
    }
    return title
}

/**
 * Knowledge — `data/knowledge/`, for an agent and for a module alike.
 *
 * Both layouts are identical on purpose: a module mirrors the agent's
 * directory, so there is one convention to learn and the scanner needs no
 * branch. What differs is `origin`, and that is what decides writability
 * downstream — a module's files live under node_modules and the next install
 * would destroy anything written there.
 *
 * `prefix` namespaces a module's entries so its `axon/agent.md` cannot
 * collide with the agent's own. Without it, whichever scanned last would
 * silently win a name the model is being told it can read.
 *
 * Discovery only. Nothing here reads a file's body — that is the kernel's
 * job at runtime, and a build that inlined 1.2MB of markdown into a blueprint
 * would carry it through every serialization the blueprint makes.
 */
export async function Knowledge(root: string, opts: { prefix?: string; required?: boolean } = {}): Promise<Scanned<AxonKnowledge>> {
    const dir = join(root, "data", "knowledge")
    const entries: AxonKnowledge[] = []
    const warnings: Scanned<AxonKnowledge>["warnings"] = []

    for (const { absPath, relPath } of await fsx.walk(dir)) {
        // Editor swap files, .DS_Store, .gitkeep — noise a model must never
        // spend context reading past.
        if (relPath.split("/").some(part => part.startsWith("."))) continue

        try {
            const info = await stat(absPath)
            if (!info.isFile()) continue

            const head = await Bun.file(absPath).slice(0, FRONTMATTER_BYTES).text()
            const name = opts.prefix ? `${opts.prefix}/${relPath}` : relPath

            entries.push({
                name,
                description: describe(head),
                size: info.size,
                path: absPath,
                origin: opts.prefix ? "module" : "agent",
                ...(opts.prefix ? { module: opts.prefix } : {}),
            })
        } catch (cause) {
            // One unreadable file must not cost the model every other entry —
            // a broken symlink or a permissions quirk is a missing entry, not
            // a broken agent. The strict/degrade split every other scanner
            // draws does not apply: there is no code here to half-load.
            warnings.push({
                domain: "knowledge",
                error: `knowledge: could not read ${relPath} — ${cause instanceof Error ? cause.message : String(cause)}`,
            })
        }
    }

    return { entries, warnings }
}
