/**
 * SSE framing — the transport half of every SSE-speaking backend (Codex,
 * OpenRouter, Cerebras). Reads a streaming Response body and yields each
 * `data:` payload as parsed JSON; the backend maps provider events to
 * EngineDelta itself. `[DONE]` sentinels are ignored; malformed data is a
 * protocol failure, never invisible data loss. Cancels the reader when the signal
 * fires so an aborted request stops pulling bytes immediately.
 */
export async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) throw new SyntaxError("SSE protocol error: response has no body")
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""

    const onAbort = () => { void reader.cancel() }
    signal?.addEventListener("abort", onAbort, { once: true })

    try {
        while (true) {
            if (signal?.aborted) return
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })

            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue
                const data = line.slice(6).trim()
                if (data === "[DONE]") continue

                try {
                    yield JSON.parse(data) as Record<string, unknown>
                } catch (error) {
                    throw new SyntaxError("SSE protocol error: malformed data frame", { cause: error })
                }
            }
        }
    } finally {
        signal?.removeEventListener("abort", onAbort)
    }
}
