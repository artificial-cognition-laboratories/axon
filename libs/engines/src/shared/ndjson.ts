/**
 * NDJSON framing — the transport half of line-delimited backends (Ollama).
 * Reads a streaming Response body and yields each line as parsed JSON;
 * the backend maps provider objects to EngineDelta itself. Blank lines are
 * skipped; malformed JSON is a protocol failure, never invisible data loss.
 * Cancels the reader when the signal fires.
 */
export async function* readNdjson(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) throw new SyntaxError("NDJSON protocol error: response has no body")
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
                const trimmed = line.trim()
                if (!trimmed) continue

                try {
                    yield JSON.parse(trimmed) as Record<string, unknown>
                } catch (error) {
                    throw new SyntaxError("NDJSON protocol error: malformed JSON line", { cause: error })
                }
            }
        }

        const trailing = buffer.trim()
        if (trailing) {
            try {
                yield JSON.parse(trailing) as Record<string, unknown>
            } catch (error) {
                throw new SyntaxError("NDJSON protocol error: malformed trailing JSON", { cause: error })
            }
        }
    } finally {
        signal?.removeEventListener("abort", onAbort)
    }
}
