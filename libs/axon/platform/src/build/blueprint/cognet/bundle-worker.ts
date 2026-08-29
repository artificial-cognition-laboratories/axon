/**
 * bundle-worker — the ONLY thing this process does: run one Bun.build() and
 * report the result on stdout as JSON, then exit. Bun.build() is a native,
 * single-threaded compute burst with no cooperative yield points — running
 * it inline in the TUI process freezes VTerm's render/input loop for the
 * whole compile (visible as a full UI hang on first boot, or any boot after
 * an @arcforge/core change, since the bundle inlines core's entire source tree).
 * Spawned as a subprocess instead, so the freeze happens off the process
 * that owns the terminal.
 *
 * Contract: argv[2] is the entry file path, argv[3] an optional
 * comma-separated list of specifiers to leave EXTERNAL. Prints exactly one
 * JSON line to stdout — { ok: true, code, mapCode? } on success,
 * { ok: false, message } on failure — then exits 0 either way. Exit code is not the signal:
 * bundleCognet() reads the JSON line, because a non-zero exit on top of a
 * malformed/partial stdout write would be a second, redundant failure path
 * to reconcile against the one that actually matters (build.success).
 */

// Standalone worker: no imports, so TS treats this as a script rather than a
// module and rejects top-level await. An empty export makes it a module.
export {}

const entryPath = process.argv[2]
if (!entryPath) {
    console.log(JSON.stringify({ ok: false, message: "bundle-worker: no entry path given" }))
    process.exit(0)
}

/**
 * Specifiers the bundle must NOT inline — resolved from the agent's
 * node_modules at runtime instead.
 *
 * Native addons are the reason. `onnxruntime-node` is ~259MB of platform-
 * specific binaries that load through a RELATIVE require from inside their
 * own package; inlining the JS wrapper moves that require next to the
 * compiled brain, where the relative path resolves to nothing. Left
 * external, the bundle emits a bare import and the runtime resolves it
 * exactly as an ordinary program would.
 *
 * This does mean a compiled cognet can have runtime dependencies — which was
 * already true of `@arcforge/cognet`, imported by bare specifier from the
 * generated entry. The list is derived from the cognet's own package.json,
 * so it is the author's declaration doing the work, not a guess here.
 */
const external = (process.argv[3] ?? "").split(",").map(s => s.trim()).filter(Boolean)

// Bun.build() reports most failures on the result (success:false + logs),
// but THROWS on others — an unresolvable import being the common one. An
// escaping throw wrote nothing to stdout and exited non-zero, so the caller
// reported "produced no output" and the actual, perfectly clear resolution
// error was lost on stderr. Both failure modes must land on the one channel
// this worker's contract promises.
let build: Awaited<ReturnType<typeof Bun.build>>
try {
    build = await Bun.build({
        entrypoints: [entryPath],
        target: "bun",
        format: "esm",
        sourcemap: "external",
        minify: false,
        ...(external.length ? { external } : {}),
    })
} catch (cause) {
    const detail = cause instanceof AggregateError
        ? cause.errors.map(e => String(e)).join("\n")
        : cause instanceof Error
            ? (cause.message || String(cause))
            : String(cause)
    console.log(JSON.stringify({ ok: false, message: detail }))
    process.exit(0)
}

if (!build.success) {
    const message = build.logs.map(l => String(l)).join("\n")
    console.log(JSON.stringify({ ok: false, message }))
    process.exit(0)
}

const entry = build.outputs.find(o => o.kind === "entry-point")
if (!entry) {
    console.log(JSON.stringify({ ok: false, message: "no entry-point output" }))
    process.exit(0)
}

const map = build.outputs.find(o => o.kind === "sourcemap")

console.log(JSON.stringify({
    ok: true,
    code: await entry.text(),
    ...(map ? { mapCode: await map.text() } : {}),
}))
process.exit(0)
