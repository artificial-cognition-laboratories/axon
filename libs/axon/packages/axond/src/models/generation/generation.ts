import { err } from "@arcforge/err"
import type { AxonEngineRawEvent, AxonEngineRequest } from "@arcforge/types"

type GenerationOpts = {
    model: string
    request: AxonEngineRequest
    run(onText: (text: string) => void, signal: AbortSignal): Promise<"end" | "length">
}

/** Turn a runtime callback into a cancellable engine stream. */
export function Generation(opts: GenerationOpts) {
    async function* stream(): AsyncGenerator<AxonEngineRawEvent> {
        const controller = new AbortController()
        const signal = opts.request.signal ? AbortSignal.any([controller.signal, opts.request.signal]) : controller.signal
        signal.throwIfAborted()
        const queue: string[] = []
        let wake: (() => void) | undefined
        let ended = false
        let fault: unknown
        let failed = false
        let stopReason: "end" | "length" = "end"
        let text = ""
        const started = Date.now()
        let firstTokenMs: number | undefined
        const work = opts.run(chunk => {
            if (signal.aborted || chunk.length === 0) return
            firstTokenMs ??= Date.now() - started
            queue.push(chunk)
            wake?.()
        }, signal).then(reason => { stopReason = reason }, cause => { fault = cause; failed = true }).finally(() => {
            ended = true
            wake?.()
        })
        try {
            while (!ended || queue.length > 0) {
                signal.throwIfAborted()
                const chunk = queue.shift()
                if (chunk !== undefined) {
                    text += chunk
                    yield { type: "text:delta", content: chunk }
                } else if (!ended) {
                    await new Promise<void>(resolve => { wake = resolve })
                    wake = undefined
                }
            }
            if (failed) throw fault
            signal.throwIfAborted()
            if (!text.trim()) throw err("MODEL_RUN_FAILED", { detail: `${opts.model} returned an empty response` })
            yield {
                type: "done",
                response: {
                    text: text,
                    stopReason: stopReason,
                    meta: { provider: "local", model: opts.model, durationMs: Date.now() - started,
                        ...(firstTokenMs !== undefined ? { firstTokenMs: firstTokenMs } : {}) },
                },
            }
        } finally {
            controller.abort()
            await work
        }
    }
    return { stream: stream }
}
