import { isAxonError } from "@arcforge/err"

/** Encode an async iterator without buffering inference; consumer departure aborts work. */
export function Stream(opts: { iterator: AsyncIterable<unknown>; controller: AbortController }) {
    function response(): Response {
        const iterator = opts.iterator[Symbol.asyncIterator]()
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const next = await iterator.next()
                    controller.enqueue(encoder.encode(JSON.stringify(next.done ? { end: true } : { value: next.value }) + "\n"))
                    if (next.done) controller.close()
                } catch (cause) {
                    const fault = isAxonError(cause) ? cause.toJSON() : undefined
                    controller.enqueue(encoder.encode(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause), fault: fault }) + "\n"))
                    controller.close()
                }
            },
            async cancel() {
                opts.controller.abort()
                await iterator.return?.()
            },
        })
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } })
    }
    return { response: response }
}
