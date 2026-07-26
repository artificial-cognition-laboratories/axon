import type { AxonEngineRequest } from "@arcforge/types"
import { failure, readNdjson } from "../shared"
import type { EngineDelta } from "../shared"

type OllamaBackendOpts = {
    host: string
    model: string
}

/**
 * OllamaBackend — owns the conversation with a local Ollama instance:
 * /api/chat body shape, reachability errors, and the mapping of its NDJSON
 * objects into EngineDelta.
 *
 * One JSON object per line:
 *   { "message": { "content": "..." }, "done": false }
 * An in-band { "error": "..." } object is a provider failure — thrown, not
 * yielded.
 */
export function OllamaBackend(opts: OllamaBackendOpts) {
    return {
        async *stream(req: AxonEngineRequest): AsyncGenerator<EngineDelta> {
            const response = await fetchChat(req, opts)

            for await (const data of readNdjson(response, req.signal)) {
                if (data.error) {
                    throw failure({ code: "PROTOCOL", message: `Ollama: ${String(data.error)}`, retryable: false, provider: "ollama", model: opts.model })
                }

                const content = (data.message as { content?: string } | undefined)?.content ?? ""
                if (content) yield { type: "text:delta", content }
            }
        },
    }
}

async function fetchChat(req: AxonEngineRequest, opts: OllamaBackendOpts): Promise<Response> {
    let response: Response
    try {
        response = await fetch(`${opts.host}/api/chat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: opts.model,
                messages: req.messages,
                stream: true,
                ...(req.maxTokens !== undefined || req.temperature !== undefined
                    ? {
                        options: {
                            ...(req.maxTokens !== undefined ? { num_predict: req.maxTokens } : {}),
                            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
                        },
                    }
                    : {}),
            }),
            ...(req.signal ? { signal: req.signal } : {}),
        })
    } catch (err) {
        if (req.signal?.aborted) {
            throw failure({ code: "ABORTED", message: "Ollama request aborted", retryable: false, provider: "ollama", model: opts.model, cause: err })
        }
        const message = err instanceof Error ? err.message : String(err)
        throw failure({ code: "TRANSPORT", message: `Ollama: could not reach ${opts.host} — is Ollama running? (${message})`, retryable: true, provider: "ollama", model: opts.model, cause: err })
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "")
        const message = `Ollama: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`
        throw failure({
            code: response.status >= 500 ? "TRANSPORT" : "INVALID_REQUEST",
            message,
            retryable: response.status >= 500,
            provider: "ollama",
            model: opts.model,
            status: response.status,
        })
    }

    return response
}
