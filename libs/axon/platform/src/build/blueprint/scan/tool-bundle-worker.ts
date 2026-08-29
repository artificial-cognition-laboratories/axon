/**
 * tool-bundle-worker — bundles a batch of local tool files into self-contained
 * ESM source, one Bun.build() over all entrypoints, reported on stdout as JSON.
 *
 * Why a subprocess (same reasoning as cognet/bundle-worker): Bun.build() is a
 * native, single-threaded compute burst with no cooperative yield points —
 * inline it would freeze VTerm's render/input loop for the whole compile.
 * Spawned off the process that owns the terminal instead.
 *
 * Why bundle at all: tools load via import() INSIDE the sandbox. If a tool were
 * passed as a raw path, its file (and every file it imports) would have to be
 * mounted into the box — which either dangles imports or re-exposes the project.
 * Bundling collapses each tool to one self-contained module the box materializes
 * from source, so nothing of the project needs mounting.
 *
 * Contract: argv[2] is a JSON array of absolute entry paths. Prints exactly one
 * JSON line to stdout — { ok: true, tools: { [path]: code } } on success,
 * { ok: false, message } on failure — then exits 0. Exit code is not the
 * signal; the caller reads the JSON line (mirrors cognet/bundle-worker).
 */

// Standalone worker: no imports, so TS treats this as a script rather than a
// module and rejects top-level await. An empty export makes it a module.
export {}

const raw = process.argv[2]
if (!raw) {
    console.log(JSON.stringify({ ok: false, message: "tool-bundle-worker: no entry paths given" }))
    process.exit(0)
}

let entryPaths: string[]
try {
    entryPaths = JSON.parse(raw) as string[]
} catch (error) {
    console.log(JSON.stringify({ ok: false, message: `tool-bundle-worker: bad argv JSON: ${String(error)}` }))
    process.exit(0)
}

const tools: Record<string, string> = {}

// One build per entry so a single malformed tool fails only itself, and each
// entry's output maps cleanly back to its source path. Bun.build resolves each
// tool's own import graph (siblings, node_modules) into the one output.
for (const entryPath of entryPaths) {
    const build = await Bun.build({
        entrypoints: [entryPath],
        target: "bun",
        format: "esm",
        minify: false,
    })

    if (!build.success) {
        const message = build.logs.map(l => String(l)).join("\n")
        console.log(JSON.stringify({ ok: false, message: `bundling ${entryPath} failed:\n${message}` }))
        process.exit(0)
    }

    const entry = build.outputs.find(o => o.kind === "entry-point")
    if (!entry) {
        console.log(JSON.stringify({ ok: false, message: `no entry-point output for ${entryPath}` }))
        process.exit(0)
    }

    tools[entryPath] = await entry.text()
}

console.log(JSON.stringify({ ok: true, tools }))
process.exit(0)
