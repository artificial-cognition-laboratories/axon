#!/usr/bin/env bun
/**
 * schema-worker — the ONLY thing this process does: extract one bench's
 * measurement schema and report it on stdout as JSON, then exit.
 *
 * ts.createProgram() is native, single-threaded compiler work with no
 * cooperative yield points — inline it freezes VTerm's render/input loop for
 * the whole call. Spawned as a subprocess instead, same reasoning and shape as
 * declare-worker.ts and bundle-worker.ts.
 *
 * Contract: argv[2] is the absolute path to bench.config.ts. Prints exactly one
 * JSON line — { ok: true, measurements } or { ok: false, message } — and exits
 * 0 either way, so a non-zero code always means the worker itself broke rather
 * than the extraction failing.
 */
import { extractBenchSchema } from "./extract"

const configPath = process.argv[2]
if (!configPath) {
    console.log(JSON.stringify({ ok: false, message: "schema-worker: no config path given" }))
    process.exit(0)
}

try {
    console.log(JSON.stringify({ ok: true, measurements: extractBenchSchema(configPath) }))
} catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
    console.log(JSON.stringify({ ok: false, message }))
}
process.exit(0)
