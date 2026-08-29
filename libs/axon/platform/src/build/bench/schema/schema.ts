import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { err } from "@arcforge/err"
import type { BenchMeasurementDefinition } from "@arcforge/types"
import { Frame } from "../../frame"

/**
 * The measurement schema, extracted from bench.config.ts and kept on disk.
 *
 * Extraction is real ts.createProgram() work — expensive and blocking — so it
 * runs in a worker and is gated on a content hash of the config, exactly like
 * declareTools(). The common case (prepare with nothing changed) never spawns
 * the worker at all.
 */
export function BenchSchema(opts: { root: string }) {
    const configPath = join(opts.root, "bench.config.ts")
    // A hash-keyed record of what the last extraction found, skipped entirely
    // when the config is unchanged — a cache in the strict sense, so it lives
    // with the others rather than loose in the frame root.
    const frame = Frame({ root: opts.root, kind: "bench" })
    const outputPath = frame.file("cache", "schema.json")

    type Cached = { hash: string; measurements: BenchMeasurementDefinition[] }

    async function read(): Promise<Cached | null> {
        const file = Bun.file(outputPath)
        if (!(await file.exists())) return null
        try {
            return (await file.json()) as Cached
        } catch {
            // A truncated or hand-edited schema.json is not a reason to fail —
            // it is regenerated from the config, which is the source of truth.
            return null
        }
    }

    async function extract(): Promise<BenchMeasurementDefinition[]> {
        const worker = new URL("./worker.ts", import.meta.url).pathname
        const proc = Bun.spawn(["bun", "run", worker, configPath], { stdout: "pipe", stderr: "pipe" })
        const [stdout, stderr, code] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
            proc.exited,
        ])

        // A worker that could not even report is a different failure from a
        // worker that reported a bad schema, and both must be loud. An empty
        // schema silently makes every measurement undeclared, so coverage
        // stops meaning anything — never fall back to one.
        if (code !== 0) {
            throw err("BENCH_SCHEMA_EXTRACTION_FAILED", {
                detail: stderr.trim() || `schema worker exited ${code}`,
                context: { configPath },
            })
        }

        let parsed: { ok: boolean; measurements?: BenchMeasurementDefinition[]; message?: string }
        try {
            parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as typeof parsed
        } catch {
            throw err("BENCH_SCHEMA_EXTRACTION_FAILED", {
                detail: `schema worker printed no result: ${stdout.slice(0, 400)}`,
                context: { configPath },
            })
        }

        if (!parsed.ok || !parsed.measurements) {
            throw err("BENCH_SCHEMA_EXTRACTION_FAILED", {
                detail: parsed.message ?? "schema worker reported failure without a message",
                context: { configPath },
            })
        }

        return parsed.measurements
    }

    return {
        /** Extract if the config changed, otherwise reuse what is on disk. */
        async load(): Promise<BenchMeasurementDefinition[]> {
            const source = await Bun.file(configPath).text()
            const hash = createHash("sha256").update(source).digest("hex")

            const cached = await read()
            if (cached?.hash === hash) return cached.measurements

            const measurements = await extract()
            frame.ensure("cache")
            await Bun.write(outputPath, JSON.stringify({ hash, measurements }, null, 2) + "\n")
            return measurements
        },
    }
}

export type BenchSchemaT = ReturnType<typeof BenchSchema>
