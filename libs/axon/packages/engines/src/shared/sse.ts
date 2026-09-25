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

    /*
     * Cancel the body when the caller aborts — and HANDLE the rejection.
     *
     * `reader.cancel()` returns a promise, and cancelling a reader whose
     * stream the transport has already errored rejects it. This listener runs
     * synchronously inside `controller.abort()`, so with a bare `void` that
     * rejection had no handler and no caller: it reached the process's fatal
     * boundary as `Runtime Error / The operation was aborted.` and replaced a
     * running TUI with a crash screen every time someone pressed Escape.
     *
     * There is nothing to report. The stream was cancelled deliberately, by
     * us, one line above — a rejection saying so is the operation confirming
     * it did what it was told.
     */
    const onAbort = () => { void reader.cancel().catch(() => undefined) }
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
                const event = parseLine(line)
                if (event) yield event
            }
        }
        // A valid final SSE frame need not have a trailing newline. Leaving it
        // in `buffer` would make a successful terminal snapshot disappear and
        // later look like an empty model response.
        if (buffer) {
            const event = parseLine(buffer)
            if (event) yield event
        }
    } finally {
        signal?.removeEventListener("abort", onAbort)
    }
}

function parseLine(line: string): Record<string, unknown> | null {
    if (!line.startsWith("data: ")) return null
    const data = line.slice(6).trim()
    if (data === "[DONE]") return null

    try {
        return JSON.parse(data) as Record<string, unknown>
    } catch (error) {
        throw new SyntaxError("SSE protocol error: malformed data frame", { cause: error })
    }
}
