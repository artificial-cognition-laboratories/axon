/**
 * Generates `src/tui-contract.ts` from `src/tui.ts`.
 *
 * The TUI contract has to exist twice: once as ordinary exported types (what
 * this package publishes, what the TUI implements against) and once as SOURCE
 * TEXT that `axon prepare` can wrap in `declare global` and write into a
 * profile's frame — because a profile has no node_modules to import through,
 * so its globals must be self-contained text.
 *
 * Rather than maintain the second copy by hand (the trap `prompt-dts.ts`
 * documents and accepts for a much smaller surface), this derives it. `tui.ts`
 * is the only authored file; run this whenever it changes.
 *
 *     bun run scripts/contract.ts
 *
 * The transform is deliberately dumb — strip `export`, indent one level — so
 * that what lands in a user's editor is the same text, comments included, that
 * a maintainer reads here. Anything cleverer would be a second dialect of the
 * contract to debug.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const SRC = join(import.meta.dir, "..", "src", "tui.ts")
const OUT = join(import.meta.dir, "..", "src", "tui-contract.ts")

await syncBundledSyntax()
await syncColorNames()

const source = readFileSync(SRC, "utf-8")

/**
 * Rewrite the `ColorName` union in `tui.ts` from VTerm's own colour parser.
 *
 * Same bargain as `BundledSyntax`: the union has to be literal text because
 * `tui.ts` is copied into frames with no node_modules, and a hand-maintained
 * list of 150+ names would drift. Read out of the parser's source rather than
 * by importing it — the names live in two module-scope tables (terminal basics
 * and the CSS3 set) that the module does not export, and parsing them here is
 * cheaper than widening VTerm's public surface for a build script.
 *
 * Every extracted name is then run THROUGH `parseColor` before being written,
 * so a table the regex misreads fails here rather than shipping a union with a
 * name that renders as nothing.
 */
async function syncColorNames(): Promise<void> {
    const vterm = join(import.meta.dir, "..", "..", "..", "tools", "vterm")
    const parserPath = join(vterm, "src", "core", "css", "color-parser.ts")
    const parserSource = readFileSync(parserPath, "utf-8")

    const basicBlock = /const BASIC_COLORS = \[([\s\S]*?)\] as const/.exec(parserSource)?.[1]
    const cssBlock = /const CSS_COLORS: Record<string, string> = \{([\s\S]*?)\n\}/.exec(parserSource)?.[1]
    if (!basicBlock || !cssBlock) {
        throw new Error(
            `Could not read colour tables from ${parserPath} — its shape changed, so ColorName cannot be generated.`,
        )
    }

    const basic = [...basicBlock.matchAll(/"([a-z]+)"/g)].map(m => m[1]!)
    const css = [...cssBlock.matchAll(/^ {4}([a-z]+):/gm)].map(m => m[1]!)
    const names = [...new Set([...basic, ...css])].sort()

    // The parser is the authority on what renders; the union only mirrors it.
    const { parseColor } = await import(parserPath)
    const unparseable = names.filter(name => parseColor(name) === null)
    if (unparseable.length > 0) {
        throw new Error(`Extracted colour names the parser rejects: ${unparseable.join(", ")}`)
    }

    const block = names.map(name => `    | ${JSON.stringify(name)}`).join("\n")
    const current = readFileSync(SRC, "utf-8")

    const markers = /( *\/\/ <color-names>\n)[\s\S]*?( *\/\/ <\/color-names>)/
    if (!markers.test(current)) {
        throw new Error("src/tui.ts is missing the <color-names> markers — ColorName cannot be generated.")
    }

    const next = current.replace(markers, `$1${block}\n$2`)
    if (next === current) {
        console.log(`ColorName already current (${names.length} colours)`)
        return
    }
    writeFileSync(SRC, next, "utf-8")
    console.log(`synced ColorName (${names.length} colours)`)
}

/**
 * Rewrite the `BundledSyntax` union in `tui.ts` from Shiki's actual bundle.
 *
 * The union has to be literal text — `tui.ts` cannot import, because it is
 * copied into frames with no node_modules — but a hand-maintained list of 50+
 * names would drift the first time Shiki adds or renames one. Drift here is
 * not cosmetic: a name in the union that Shiki lacks typechecks fine and then
 * loads nothing at runtime, which is the exact failure the union exists to
 * prevent.
 *
 * So the list is generated between markers and everything around it — the
 * doc comment, `arcnight`, the type's name — stays authored. Same bargain as
 * the contract itself: one source of truth, mechanically copied.
 */
async function syncBundledSyntax(): Promise<void> {
    // Resolved out of VTerm rather than imported directly: shiki belongs to the
    // renderer that highlights with it, and `@arcforge/types` has no runtime
    // dependencies at all — adding one so a build script can read a list would
    // be the wrong trade for every consumer of this package.
    const shikiPath = Bun.resolveSync("shiki", join(import.meta.dir, "..", "..", "..", "tools", "vterm"))
    const { bundledThemes } = await import(shikiPath)
    const names = Object.keys(bundledThemes).sort()

    const block = names.map(name => `    | ${JSON.stringify(name)}`).join("\n")
    const current = readFileSync(SRC, "utf-8")

    const markers = /( *\/\/ <bundled-syntax>\n)[\s\S]*?( *\/\/ <\/bundled-syntax>)/
    if (!markers.test(current)) {
        throw new Error(
            "src/tui.ts is missing the <bundled-syntax> markers — BundledSyntax cannot be generated.",
        )
    }

    const next = current.replace(markers, `$1${block}\n$2`)
    if (next === current) {
        console.log(`BundledSyntax already current (${names.length} themes)`)
        return
    }
    writeFileSync(SRC, next, "utf-8")
    console.log(`synced BundledSyntax (${names.length} themes)`)
}

// `tui.ts` must have no imports — it is copied verbatim into a directory with
// no node_modules, so an import there is a broken profile. Asserted rather than
// stripped: silently dropping one would produce globals referencing a type that
// does not exist, which fails far from the cause.
const imports = source.split("\n").filter(line => /^\s*import\s/.test(line))
if (imports.length > 0) {
    throw new Error(
        `src/tui.ts must not import — it is copied into frames with no node_modules.\nFound:\n${imports.join("\n")}`,
    )
}

const body = source
    .split("\n")
    // Strip only a LEADING `export` — the declaration stays, it just stops
    // being a module export once it lives inside `declare global`.
    .map(line => line.replace(/^export (type|function|const|interface) /, "$1 "))
    .map(line => (line.length > 0 ? `    ${line}` : line))
    .join("\n")
    .trimEnd()

writeFileSync(
    OUT,
    `// GENERATED by scripts/contract.ts from src/tui.ts — do not edit.
//
// The TUI contract as source text, for \`axon prepare\` to wrap in
// \`declare global\` and write into a profile's or extension's type frame.
// A profile has no node_modules, so its globals cannot import — they must be
// this text, inlined.

export const TUI_CONTRACT = ${JSON.stringify(body)}
`,
    "utf-8",
)

console.log(`wrote ${OUT} (${body.split("\n").length} lines)`)
