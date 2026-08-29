import { err } from "@arcforge/err"

type HttpOpts = {
    /** Daemon base URL, e.g. http://localhost:11434. */
    host: string
}

/**
 * Http — every request to the local Ollama daemon.
 *
 * The daemon is optional infrastructure: a user who has never installed Ollama
 * is in a perfectly ordinary state, so "not reachable" must arrive as a
 * structured OLLAMA_UNAVAILABLE rather than a raw fetch TypeError that reads
 * like a bug. Everything else — a 404 for an unknown model, a 500 — surfaces
 * with the daemon's own message, because it is the daemon's answer and it is
 * usually the right thing to show.
 */
export function Http(opts: HttpOpts) {
    const host = opts.host.replace(/\/+$/, "")

    /**
     * `body` is the VALUE to send, not an encoded string — this owns the
     * JSON encoding so no caller can send an unencoded object by mistake.
     * Its presence also selects the method: Ollama's read endpoints are GET,
     * everything else POSTs a payload.
     */
    async function send(path: string, body?: unknown): Promise<Response> {
        const url = `${host}${path}`

        let response: Response
        try {
            response = await fetch(url, body === undefined
                ? {}
                : {
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: { "content-type": "application/json" },
                })
        } catch (cause) {
            // A connection that cannot be opened is the ONE failure that is not
            // a fault: Ollama is not installed, or not running.
            throw err("OLLAMA_UNAVAILABLE", {
                detail: `no Ollama daemon at ${host} — start it with \`ollama serve\`, or install it from https://ollama.com`,
                context: { host: host },
                cause: cause,
            })
        }

        if (!response.ok) {
            const body = await response.text().catch(() => "")
            const message = parseErrorBody(body) ?? `${response.status} ${response.statusText}`
            throw err("OLLAMA_REQUEST_FAILED", {
                detail: `${path}: ${message}`,
                context: { host: host, path: path, status: response.status },
            })
        }

        return response
    }

    return {
        host: host,

        /** A JSON request/response round trip. */
        async json<T>(path: string, body?: unknown): Promise<T> {
            const response = await send(path, body)
            return await response.json() as T
        },

        /**
         * An NDJSON stream — one JSON object per line, which is how Ollama
         * reports long operations like a pull.
         *
         * Lines are reassembled across chunk boundaries: a 4 MB download emits
         * progress faster than the reader drains it, so a naive split drops the
         * partial line at the end of every chunk.
         */
        async *stream<T>(path: string, body: unknown): AsyncGenerator<T> {
            const response = await send(path, body)
            if (!response.body) {
                throw err("OLLAMA_REQUEST_FAILED", { detail: `${path}: response carried no body`, context: { path: path } })
            }

            const reader = response.body.getReader()
            const decoder = new TextDecoder()
            let carry = ""

            try {
                while (true) {
                    const { value, done } = await reader.read()
                    if (done) break

                    carry += decoder.decode(value, { stream: true })
                    const lines = carry.split("\n")
                    carry = lines.pop() ?? ""

                    for (const line of lines) {
                        if (line.trim()) yield JSON.parse(line) as T
                    }
                }
                if (carry.trim()) yield JSON.parse(carry) as T
            } finally {
                // A consumer that breaks out of the loop early (a cancelled
                // download) must not leave the socket held open.
                await reader.cancel().catch(() => {})
            }
        },
    }
}

export type HttpT = ReturnType<typeof Http>

/** Ollama reports failures as `{"error": "..."}` — prefer that over a bare status line. */
function parseErrorBody(body: string): string | null {
    if (!body.trim()) return null
    try {
        const parsed = JSON.parse(body) as { error?: unknown }
        return typeof parsed.error === "string" ? parsed.error : null
    } catch {
        // Not JSON — the raw body is still better than nothing, trimmed so a
        // stray HTML error page cannot flood a terminal.
        return body.trim().slice(0, 200)
    }
}
