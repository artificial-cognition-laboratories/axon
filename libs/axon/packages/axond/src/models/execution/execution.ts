import { err } from "@arcforge/err"
import type { AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"
import type { LoadedWeight } from "../adapter"

type ExecutionOpts = { acquire(model: string): Promise<LoadedWeight> }

/** Serialize calls per weight and keep removal away from queued or active inference. */
export function Execution(opts: ExecutionOpts) {
    const tails = new Map<string, Promise<void>>()
    const users = new Map<string, number>()
    async function lease(model: string, signal?: AbortSignal): Promise<() => void> {
        signal?.throwIfAborted()
        const previous = tails.get(model)
        let release!: () => void
        const next = new Promise<void>(resolve => { release = resolve })
        tails.set(model, next)
        users.set(model, (users.get(model) ?? 0) + 1)
        const done = () => {
            const count = users.get(model)
            if (count === undefined) throw err("MODEL_RUN_FAILED", { detail: "execution lease disappeared" })
            if (count === 1) users.delete(model)
            else users.set(model, count - 1)
            release()
            if (tails.get(model) === next) tails.delete(model)
        }
        await previous
        try { signal?.throwIfAborted() } catch (cause) { done(); throw cause }
        return done
    }
    function assertIdle(model: string): void {
        if (users.has(model)) throw err("MODEL_IN_USE", { detail: `${model} has queued or active inference — interrupt it before unloading or removing` })
    }
    async function run(input: { model: string; input: unknown }): Promise<unknown> {
        const release = await lease(input.model)
        try {
            const weight = await opts.acquire(input.model)
            return weight.engine === "generate" && weight.generate && typeof input.input === "string"
                ? await weight.generate({ prompt: input.input })
                : await weight.run(input.input)
        } finally { release() }
    }
    async function* stream(input: { model: string; request: AxonEngineRequest }, signal?: AbortSignal): AsyncGenerator<AxonEngineRawEvent> {
        const request = { ...input.request, ...(signal ? { signal: signal } : {}) }
        const release = await lease(input.model, request.signal)
        try {
            const weight = await opts.acquire(input.model)
            request.signal?.throwIfAborted()
            if (!weight.chat) throw err("MODEL_INPUT_INVALID", { detail: `${input.model} does not support conversational inference` })
            for await (const event of weight.chat(request)) {
                yield event.type === "done"
                    ? { ...event, response: { ...event.response, meta: { ...event.response.meta, model: input.model } } }
                    : event
            }
        } finally { release() }
    }
    return { run: run, stream: stream, assertIdle: assertIdle, busy: (model: string) => users.has(model) }
}
