import { join } from "node:path"
import { fsx } from "../../../utils/fs"
import type { DeclaredFile } from "./declare"

/**
 * Published — read a module's tools from the manifest it shipped, instead of
 * re-deriving them from its installed source.
 *
 * THE BUG THIS EXISTS FOR. `declareTools()` runs a real `ts.createProgram()`
 * and asks it to emit declarations. TypeScript treats `node_modules` as
 * EXTERNAL LIBRARY CODE and silently skips declaration emit for anything
 * inside it — so a module whose tool file imports a sibling
 * (`../arxiv/client.ts`) got exactly one `.d.ts` where it needed two, and
 * every type declared in that sibling became unresolvable.
 *
 * Proven with byte-identical files: outside node_modules two declarations
 * emit and the scan passes; inside node_modules one emits and the scan throws
 * `type "QueryOptions" is used in an exported signature but has no resolvable
 * definition` — pointing the author at a re-export their source already had.
 *
 * The fix is not to compile harder. It is to stop re-deriving something the
 * publish step ALREADY COMPUTED: a published module ships
 * `.module/build/manifest.json` carrying each tool's `fns`, its
 * `ambientTypes`, and its bundled `source`. Those were emitted in the module's
 * own directory, where the compiler behaves — so they are strictly MORE
 * correct than anything a consumer can derive from the installed copy.
 *
 * It is also faster: the whole `ts.createProgram()` (500ms-1.5s cold) and the
 * bundle step collapse into one file read.
 *
 * This applies ONLY to installed modules. An agent's own `src/tools/` is
 * source under development with no manifest and no publish behind it, and it
 * must keep compiling from source — that is where a type error should surface.
 */

/** What a published manifest records for one tool file. */
type PublishedTool = {
    name: string
    fns: DeclaredFile["fns"]
    ambientTypes?: string[]
    /** Bundled, self-contained source — what the capsule loads. */
    source?: string
    /** Absolute path on the PUBLISHER's machine. Never used to read from. */
    entryPath?: string
}

type PublishedManifest = {
    name?: string
    version?: string
    kind?: string
    tools?: PublishedTool[]
}

/**
 * What a consumer needs from a published module, in the scan's own shapes.
 *
 * Keyed by ABSOLUTE FILE PATH rather than tool name, because that is what the
 * scan's own maps are keyed by and this stands in for them exactly. The paths
 * are rebuilt from the CONSUMER's tools directory — the manifest's `entryPath`
 * is where the file lived on the publisher's machine and means nothing here.
 */
export type PublishedTools = {
    /** Absolute tool file path → its declarations. */
    declared: Map<string, DeclaredFile>
    /** Absolute tool file path → its bundled source. */
    bundled: Map<string, string>
}

/**
 * Read a published module's tool manifest, or null when there is not a
 * complete one to read.
 *
 * Null is the honest answer for every partial case — no manifest, no tools
 * key, a tool missing its declarations or its bundled source, or a manifest
 * describing a different set of tools than the installed source actually has.
 * The caller falls back to compiling from source, which is what happens today
 * and is never worse than what it replaces. Nothing here guesses: a manifest
 * that cannot answer the whole question does not get to answer part of it.
 *
 * `toolFiles` is the set the scan found on disk. Requiring the manifest to
 * cover exactly that set is what keeps this honest — a manifest listing fewer
 * tools than are installed would silently drop one from the model's scope, and
 * one listing MORE would describe a tool whose source is not there.
 */
export async function publishedTools(
    root: string,
    toolFiles: string[],
): Promise<PublishedTools | null> {
    const manifest = await fsx.readJson<PublishedManifest>(
        join(root, ".module", "build", "manifest.json"),
    )
    if (!manifest?.tools || manifest.tools.length === 0) return null

    // Tool name → the installed file it corresponds to. A manifest entry is
    // named for its file's basename without the extension, which is the same
    // derivation the scan uses when it builds `entries`.
    const byName = new Map<string, string>()
    for (const filePath of toolFiles) {
        const base = filePath.slice(filePath.lastIndexOf("/") + 1)
        byName.set(base.slice(0, -3), filePath)
    }

    const declared = new Map<string, DeclaredFile>()
    const bundled = new Map<string, string>()

    for (const tool of manifest.tools) {
        // Every field the scan would have produced has to be present. A tool
        // with declarations but no bundled source would enter the model's
        // scope as something the capsule cannot load — a tool that is
        // described and uncallable, which is worse than one that is absent.
        if (!tool.name || !Array.isArray(tool.fns) || tool.fns.length === 0) return null
        if (typeof tool.source !== "string" || tool.source.length === 0) return null

        const filePath = byName.get(tool.name)
        // The manifest names a tool this installation does not have. The two
        // disagree about what is installed, so neither is trustworthy.
        if (!filePath) return null

        declared.set(filePath, {
            fns: tool.fns,
            ambientTypes: tool.ambientTypes ?? [],
        })
        bundled.set(filePath, tool.source)
    }

    // Every installed tool file must be covered. A file the manifest does not
    // describe would silently vanish from scope.
    if (declared.size !== toolFiles.length) return null

    return { declared, bundled }
}
