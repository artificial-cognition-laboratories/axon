import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { LabAction, LabActionResult, LabIntervention } from "./types"

/** Durable audit of requested world changes and their actual outcomes. */
export function Interventions(opts: { root: string; execute: (action: LabAction) => Promise<LabActionResult> }) {
    const file = join(opts.root, "interventions.jsonl")

    async function write(event: LabIntervention): Promise<void> {
        await mkdir(opts.root, { recursive: true })
        await appendFile(file, `${JSON.stringify(event)}\n`)
    }

    return {
        async act(action: LabAction): Promise<LabActionResult> {
            const id = randomUUID()
            await write({ id: id, at: Date.now(), action: action, status: "requested" })
            let result: LabActionResult
            try {
                result = await opts.execute(action)
            } catch (cause) {
                const detail = cause instanceof Error ? cause.message : String(cause)
                await write({ id: id, at: Date.now(), action: action, status: "failed", detail: detail })
                throw cause
            }
            await write({ id: id, at: result.at, action: action, status: "succeeded", detail: result.result })
            return result
        },
        async history(): Promise<LabIntervention[]> {
            if (!existsSync(file)) return []
            const text = await readFile(file, "utf-8")
            const events = text.split("\n").filter(Boolean).map(line => JSON.parse(line) as LabIntervention)
            const latest = new Map<string, LabIntervention>()
            for (const event of events) latest.set(event.id, event)
            return [...latest.values()].slice(-100).reverse()
        },
    }
}
