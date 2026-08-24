import type { AxonEngineRequest } from "@arcforge/types"
import { failure, readSse } from "../shared"
import type { EngineDelta } from "../shared"

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

type OpenRouterBackendOpts = {
    /** Resolved per request — env key or a vault-minted token (cached by the vault client until expiry). */
    key: () => Promise<string>
    model: string
    baseUrl?: string
}

/**
 * OpenRouterBackend — owns the conversation with openrouter.ai: auth
 * header, OpenAI-compatible body, HTTP error mapping, and the mapping of
 * its SSE chunks into EngineDelta.
 *
 * Standard OpenAI SSE format:
 *   data: { "choices": [{ "delta": { "content": "...", "reasoning": "..." } }] }
 * content chunks → text:delta (raw AIR tokens intact)
 * reasoning chunks → thinking:delta (pre-separated by the provider)
 */
export function OpenRouterBackend(opts: OpenRouterBackendOpts) {
    const url = opts.baseUrl ?? OPENROUTER_URL

    return {
        async *stream(req: AxonEngineRequest): AsyncGenerator<EngineDelta> {
            const response = await fetchCompletions(req, url, opts)

            for await (const event of readSse(response, req.signal)) {
                const delta = (event.choices as Array<{ delta?: { content?: string | null; reasoning?: string | null } }> | undefined)?.[0]?.delta

                const reasoning = delta?.reasoning ?? ""
                if (reasoning) yield { type: "thinking:delta", content: reasoning }

                const content = delta?.content ?? ""
                if (content) yield { type: "text:delta", content }
            }
        },
    }
}

async function fetchCompletions(req: AxonEngineRequest, url: string, opts: OpenRouterBackendOpts): Promise<Response> {
    let response: Response
    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${await opts.key()}`,
                "HTTP-Referer": "https://axon.arclabs.it",
                "X-Title": "Axon",
            },
            body: JSON.stringify({
                model: opts.model,
                messages: req.messages,
                stream: true,
                ...(req.maxTokens != null ? { max_tokens: req.maxTokens } : {}),
                ...(req.temperature != null ? { temperature: req.temperature } : {}),
            }),
            ...(req.signal ? { signal: req.signal } : {}),
        })
    } catch (err) {
        if (req.signal?.aborted) {
            throw failure({ code: "ABORTED", message: "OpenRouter request aborted", retryable: false, provider: "openrouter", model: opts.model, cause: err })
        }
        const message = err instanceof Error ? err.message : String(err)
        throw failure({ code: "TRANSPORT", message: `OpenRouter: network error — ${message}`, retryable: true, provider: "openrouter", model: opts.model, cause: err })
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "")
        const common = { provider: "openrouter", model: opts.model, status: response.status }
        if (response.status === 401) throw failure({ ...common, code: "AUTH", message: "OpenRouter: invalid API key — check your key at openrouter.ai/keys", retryable: false })
        if (response.status === 402) throw failure({ ...common, code: "QUOTA", message: "OpenRouter: insufficient credits — top up at openrouter.ai", retryable: false })
        if (response.status === 429) throw failure({ ...common, code: "RATE_LIMIT", message: "OpenRouter: rate limited — try again shortly", retryable: true, ...retryAfter(response) })
        const message = `OpenRouter: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`
        throw failure({ ...common, code: response.status >= 500 ? "TRANSPORT" : "INVALID_REQUEST", message, retryable: response.status >= 500 })
    }

    return response
}

function retryAfter(response: Response): { retryAfterMs?: number } {
    const value = response.headers.get("retry-after")
    if (!value) return {}
    const seconds = Number(value)
    if (Number.isFinite(seconds)) return { retryAfterMs: Math.max(0, seconds * 1000) }
    const at = Date.parse(value)
    return Number.isNaN(at) ? {} : { retryAfterMs: Math.max(0, at - Date.now()) }
}
