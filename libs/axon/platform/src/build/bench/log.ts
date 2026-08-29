import { appendFile, mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { BenchEvent, BenchEventContext, BenchEventMap } from "@arcforge/types"
import { err } from "@arcforge/err"

export type BenchLogOpts = { root: string }

export function BenchLog(opts: BenchLogOpts) {
    const sequences = new Map<string, number>()
    const runDir = (runId: string) => join(opts.root, ".bench", "runs", runId)
    return {
        runDir,
        async emit<K extends keyof BenchEventMap>(context: BenchEventContext, type: K, data: BenchEventMap[K]): Promise<BenchEvent> {
            const seq = sequences.get(context.benchRunId) ?? 0
            sequences.set(context.benchRunId, seq + 1)
            const event = {
                id: Bun.randomUUIDv7(),
                type,
                time: { ms: Date.now(), seq },
                context,
                data,
            } as BenchEvent
            const dir = runDir(context.benchRunId)
            await mkdir(dir, { recursive: true })
            await appendFile(join(dir, "events.jsonl"), JSON.stringify(event) + "\n")
            return event
        },
        async read(runId: string): Promise<BenchEvent[]> {
            const file = Bun.file(join(runDir(runId), "events.jsonl"))
            if (!await file.exists()) throw err("BENCH_RUN_NOT_FOUND", { context: { runId } })
            const text = await file.text()
            return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as BenchEvent)
        },
        async writeResult(runId: string, result: unknown): Promise<void> {
            const dir = runDir(runId)
            await mkdir(dir, { recursive: true })
            await Bun.write(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n")
        },
        async writeManifest(runId: string, manifest: unknown): Promise<void> {
            const dir = runDir(runId)
            await mkdir(dir, { recursive: true })
            await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
        },
    }
}

export type BenchLogT = ReturnType<typeof BenchLog>
