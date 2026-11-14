import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import type { AxonEngineRawEvent } from "@arcforge/types"

/** Journal model lifecycle outcomes without recording prompts or generated content. */
export function Activity(opts: { path: string }) {
    function emit(operation: string, phase: "start" | "done" | "error", id: string, subject: string, error?: unknown): void {
        mkdirSync(dirname(opts.path), { recursive: true })
        appendFileSync(opts.path, JSON.stringify({ type: `axon:model:${phase}`, at: Date.now(), operation: operation, id: id, subject: subject,
            ...(error !== undefined ? { error: error instanceof Error ? error.message : String(error) } : {}) }) + "\n")
    }
    async function run<T>(operation: string, subject: string, work: () => Promise<T>): Promise<T> {
        const id = randomUUID()
        emit(operation, "start", id, subject)
        try {
            const result = await work()
            emit(operation, "done", id, subject)
            return result
        } catch (cause) { emit(operation, "error", id, subject, cause); throw cause }
    }
    async function* stream(subject: string, work: () => AsyncGenerator<AxonEngineRawEvent>): AsyncGenerator<AxonEngineRawEvent> {
        const id = randomUUID()
        emit("inference", "start", id, subject)
        let completed = false
        let failure: unknown
        try {
            for await (const event of work()) { completed ||= event.type === "done"; yield event }
        } catch (cause) { failure = cause; throw cause }
        finally { emit("inference", completed ? "done" : "error", id, subject, completed ? undefined : failure ?? "consumer left before completion") }
    }
    return { path: opts.path, run: run, stream: stream }
}
export type ActivityT = ReturnType<typeof Activity>
