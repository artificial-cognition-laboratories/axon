import { readFile } from "node:fs/promises"
import { dirname, relative, resolve } from "node:path"
import { err } from "@arcforge/err"

/**
 * Refuse a config that imports from outside the project.
 *
 * ── Why this is a bundle-time check ────────────────────────────────────────
 *
 * A bundle contains the project directory and nothing above it. An agent whose
 * `axon.config.ts` reaches upward — `import Cognet from "../../cognets/zero"` —
 * therefore publishes a config that imports a file which was never shipped. It
 * runs perfectly on the machine that wrote it and dies at boot in the cloud
 * with `Cannot find module`, from inside a container, AFTER provisioning has
 * been paid for. `axon build` reported success the whole time.
 *
 * So the check runs where the tarball is assembled, which is what makes it
 * cover `publish` as well: a published agent with this fault is broken for
 * everyone who installs it, not only for the author.
 *
 * ── Why refusing rather than rewriting ────────────────────────────────────
 *
 * The `cognet:` case looks rewritable — the compiled brain is staged at a path
 * the manifest already declares, so the import could be pointed there. But
 * that is a special case masking a general fault: any out-of-root import has
 * the same problem, and a shared `../lib/utils` cannot be rewritten into
 * anything. Patching the one shape we recognise would leave the others failing
 * exactly as they do now, with the added confusion that one of them silently
 * worked.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * The config only. It is the file the container evaluates before anything
 * else, so it is where this fails first and hardest, and checking it needs no
 * import graph. A `src/` file reaching upward is the same fault and is NOT
 * caught here — worth widening to when there is a reason to walk the graph.
 */

/** A relative specifier in an import/export/`from` position, or a bare `import(...)`. */
const SPECIFIER = /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g

export type EscapingImport = {
    /** The specifier as written. */
    specifier: string
    /** 1-based line it appears on, for the report. */
    line: number
}

/**
 * Relative specifiers in `source` that resolve outside `root`.
 *
 * Bare specifiers (`@axon/zero`, `node:fs`) are skipped: those are package
 * names resolved from node_modules, which the bundle carries or the consumer
 * installs. Only a path can escape.
 */
export function escapingImports(source: string, configPath: string, root: string): EscapingImport[] {
    const from = dirname(configPath)
    const found: EscapingImport[] = []

    for (const match of source.matchAll(SPECIFIER)) {
        const specifier = match[1] ?? match[2]
        if (!specifier || !specifier.startsWith(".")) continue

        const target = resolve(from, specifier)
        const rel = relative(root, target)
        // `..` at the front, or an absolute result, means the path left the
        // tree. relative() is the reliable test — a string comparison misses
        // `./a/../../b`.
        if (!rel.startsWith("..") && rel !== "") continue

        // Counted to where the SPECIFIER sits, not to the match start: the
        // pattern's leading `(?:^|\s)` swallows the preceding newline, so
        // measuring from match.index reports the line above.
        found.push({
            specifier,
            line: source.slice(0, source.indexOf(specifier, match.index)).split("\n").length,
        })
    }

    return found
}

/** Throw if the project's config imports anything from outside `root`. */
export async function assertConfigContained(root: string, configPath: string): Promise<void> {
    const source = await readFile(configPath, "utf-8").catch(() => null)
    if (source === null) return

    const escaping = escapingImports(source, configPath, root)
    if (escaping.length === 0) return

    const where = escaping
        .map(entry => `${relative(root, configPath)}:${entry.line}  ${entry.specifier}`)
        .join("\n")

    throw err("CONFIG_IMPORT_ESCAPES_ROOT", {
        detail: where,
        context: {
            imports: escaping.map(entry => entry.specifier),
            root,
        },
    })
}
