/**
 * declare-worker — the ONLY thing this process does: run declareTools()
 * over one directory's tool files and report the result on stdout as
 * JSON, then exit. ts.createProgram() (module resolution + type-checking)
 * is native, single-threaded compiler work with no cooperative yield
 * points — inline, it freezes VTerm's render/input loop for the whole
 * call (commonly 500ms-1.5s cold). Spawned as a subprocess instead, same
 * reasoning and shape as bundle-worker.ts.
 *
 * Contract: argv[2] is a JSON-encoded string[] of absolute tool file
 * paths. Prints exactly one JSON line to stdout — { ok: true, files: [[path,
 * DeclaredFile], ...] } on success, { ok: false, message } on failure —
 * then exits 0 either way, same non-exit-code-signals-failure reasoning
 * as bundle-worker.ts.
 */
import { declareTools } from "./declare"

/** One request → one JSON line, in the shape the caller parses. */
function declare(raw: string): string {
    try {
        const fileNames = JSON.parse(raw) as string[]
        const declared = declareTools(fileNames)
        return JSON.stringify({ ok: true, files: [...declared.entries()] })
    } catch (error) {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
        return JSON.stringify({ ok: false, message })
    }
}

/**
 * SERVE MODE — `declare-worker --serve`, one request per stdin line.
 *
 * Same contract per line as the one-shot form, and it exists for one reason:
 * declareTools() parses TypeScript's entire standard library to build its
 * program, which is ~1.0s of the ~1.0s a small scan costs. That parse is
 * cached per PROCESS (see declare.ts), so a process that answers once throws
 * the cache away and the next scan pays it again. Staying alive turns the
 * second and every later request into ~0.07s.
 *
 * Worth it because scanning several roots in one run is the normal case, not
 * an edge: an agent scans its own tools plus one root per installed module.
 * Exits when stdin closes, so the worker cannot outlive the caller that
 * spawned it.
 */
if (process.argv[2] === "--serve") {
    for await (const line of console) {
        const request = line.trim()
        if (!request) continue
        console.log(declare(request))
    }
    process.exit(0)
}

const raw = process.argv[2]
if (!raw) {
    console.log(JSON.stringify({ ok: false, message: "declare-worker: no file list given" }))
    process.exit(0)
}

console.log(declare(raw))
process.exit(0)
