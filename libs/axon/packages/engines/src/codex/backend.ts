import type { AxonEngineRequest, EngineCloud } from "@arcforge/types"
import { HttpError } from "@arcforge/types"
import { failure, readSse } from "../shared"
import type { EngineDelta } from "../shared"

// Codex uses the ChatGPT backend, not api.openai.com
const CODEX_BASE_URL = "https://chatgpt.com/backend-api"
const CODEX_RESPONSES_PATH = "/codex/responses"

type CodexBackendOpts = {
    cloud: EngineCloud
    model: string
    effort: string
}

/**
 * CodexBackend — owns the conversation with chatgpt.com: vault token
 * resolution, request-body shape, auth headers, HTTP error mapping, and
 * the mapping of Codex's SSE events into EngineDelta. Pure wire; no
 * accumulation, no response assembly — that's the orchestrator's Collect.
 *
 * Two delta channels: reasoning_summary_text.delta (thinking tokens,
 * pre-separated by OpenAI) and output_text.delta (raw model output, AIR
 * XML tags intact — Cognos handles all AIR parsing downstream).
 * response.output_text.done carries the authoritative full text.
 */
export function CodexBackend(opts: CodexBackendOpts) {
    return {
        async *stream(req: AxonEngineRequest): AsyncGenerator<EngineDelta> {
            // Fresh per request: minted server-side from the vault, cached
            // by the cloud client until expiry. Throws VAULT_NOT_CONNECTED
            // when the account has no OpenAI connection.
            let credential
            try {
                credential = await opts.cloud.user.vault.connections.openai.token()
            } catch (err) {
                if (err instanceof HttpError && err.data?.code === "VAULT_CONNECTION_NOT_FOUND" && err.data.provider === "openai") {
                    throw failure({
                        code: "AUTH_NOT_CONNECTED",
                        message: "Codex subscription not connected — run :provider codex connect and try again",
                        retryable: false,
                        provider: "codex",
                        model: opts.model,
                        status: err.status,
                        cause: err,
                    })
                }
                throw err
            }
            const response = await fetchResponses(req, credential.accessToken, credential.accountId, opts)

            for await (const event of readSse(response, req.signal)) {
                const type = event.type as string | undefined
                if (type === "response.reasoning_summary_text.delta") {
                    const content = (event.delta as string | undefined) ?? ""
                    if (content) yield { type: "thinking:delta", content }
                } else if (type === "response.output_text.delta") {
                    const content = (event.delta as string | undefined) ?? ""
                    if (content) yield { type: "text:delta", content }
                } else if (type === "response.output_text.done") {
                    const content = (event.text as string | undefined) ?? ""
                    if (content.trim()) yield { type: "text:final", content }
                } else if (type === "response.content_part.done" || type === "response.output_item.done") {
                    // The terminal content/item snapshots are documented
                    // Responses events. They are a safe fallback when a
                    // connection omits output_text.done after sending a
                    // completed item.
                    const content = outputText(event.type === "response.content_part.done" ? event.part : event.item)
                    if (content.trim()) yield { type: "text:final", content }
                } else if (type === "response.completed") {
                    const response = object(event.response)
                    const status = response?.status
                    if (status !== "completed") {
                        const detail = outputText(response?.error) || `response ended with status ${String(status ?? "unknown")}`
                        throw failure({
                            code: "TRANSPORT",
                            message: `Codex: ${detail}`,
                            retryable: status !== "cancelled",
                            provider: "codex",
                            model: opts.model,
                        })
                    }
                    const content = outputText(response)
                    if (content.trim()) yield { type: "text:final", content }
                }
            }
        },
    }
}

/** Extract visible output from a Responses content item or terminal response. */
function outputText(value: unknown): string {
    const record = object(value)
    if (!record) return ""
    if (typeof record.text === "string") return record.text
    const content = Array.isArray(record.content) ? record.content : Array.isArray(record.output) ? record.output : []
    return content.map(outputText).join("")
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

async function fetchResponses(
    req: AxonEngineRequest,
    accessToken: string,
    accountId: string,
    opts: CodexBackendOpts
): Promise<Response> {
    const systemMessages = req.messages.filter(m => m.role === "system")
    const nonSystemMessages = req.messages.filter(m => m.role !== "system")
    const instructions = systemMessages.map(m => m.content).join("\n\n") || undefined
    // The content type follows the ROLE. The Responses API accepts
    // `input_text` only on input roles; an assistant turn is output and must
    // be `output_text`, or the request is rejected outright:
    //
    //   400 — Invalid value: 'input_text'. Supported values are:
    //   'output_text' and 'refusal'.  (param: input[1].content[0])
    //
    // Hardcoded until the history began rendering as real chat turns, which
    // is when an assistant message first reached a driver at all.
    const input = nonSystemMessages.map(m => {
        const assistant = m.role === "assistant"
        return {
            type: "message",
            role: assistant ? "assistant" : "user",
            content: [{ type: assistant ? "output_text" : "input_text", text: m.content }],
        }
    })

    const body = {
        model: opts.model,
        ...(instructions ? { instructions } : {}),
        input,
        store: false,
        stream: true,
        reasoning: { effort: opts.effort, summary: "auto" },
        text: { verbosity: "medium" },
        include: ["reasoning.encrypted_content"],
    }

    let response: Response
    try {
        response = await fetch(`${CODEX_BASE_URL}${CODEX_RESPONSES_PATH}`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${accessToken}`,
                "chatgpt-account-id": accountId,
                "OpenAI-Beta": "responses=experimental",
                "originator": "codex_cli_rs",
                "accept": "text/event-stream",
            },
            body: JSON.stringify(body),
            ...(req.signal ? { signal: req.signal } : {}),
        })
    } catch (err) {
        if (req.signal?.aborted) {
            throw failure({ code: "ABORTED", message: "Codex request aborted", retryable: false, provider: "codex", model: opts.model, cause: err })
        }
        const message = err instanceof Error ? err.message : String(err)
        throw failure({ code: "TRANSPORT", message: `Codex: network error — ${message}`, retryable: true, provider: "codex", model: opts.model, cause: err })
    }

    if (!response.ok) {
        const text = await response.text().catch(() => "")
        const common = { provider: "codex", model: opts.model, status: response.status }
        if (response.status === 401) throw failure({ ...common, code: "AUTH", message: "Codex: authentication failed — reconnect via `:provider openai connect`.", retryable: false })
        if (response.status === 429) throw failure({ ...common, code: "RATE_LIMIT", message: "Codex: usage limit reached. Check your ChatGPT subscription.", retryable: true, ...retryAfter(response) })
        const message = `Codex: ${response.status} ${response.statusText}${text ? ` — ${text}` : ""}`
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
