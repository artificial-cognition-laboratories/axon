import type { AxonEngineRawEvent, AxonEngineResponse, EngineAutoLimits, EngineAutoWeights, EngineCloudStream } from "@arcforge/types"
import type { HttpClient } from "../platform/http"

type EngineOpts = {
    http: HttpClient
}

/** A selector to resolve — the routing half of a call, with no request attached. */
export type EngineResolve = {
    /** Catalog model ID, or "auto" to ask what the curated scoring would pick. */
    model: string
    /** Only meaningful when model is "auto" — ignored otherwise. */
    optimize?: EngineAutoWeights
    /** Only meaningful when model is "auto" — ignored otherwise. */
    limit?: EngineAutoLimits
}

/** What a selector resolves to — the real catalog model, and what it would cost. */
export type ResolvedEngineModel = {
    /** The canonical catalog id, e.g. "anthropic/claude-sonnet-4.6". Never "auto". */
    model: string
    /** Minor units (pence) per 1M tokens, BEFORE markup. */
    pricing: { inPerMTok: number; outPerMTok: number }
    /** Flat multiplier applied to upstream cost. */
    markup: number
}

/**
 * Engine — managed inference. Streams /api/engine/stream: the backend
 * routes to the target model server-side, meters usage, and debits the
 * caller's ledger; the terminal done event's meta (tokens, cost) is
 * authoritative — it IS the ledger entry. The @arcforge/engines Axon() engine
 * is a pure forwarder onto this.
 */
export function Engine(opts: EngineOpts) {
    async function* stream(input: EngineCloudStream): AsyncGenerator<AxonEngineRawEvent> {
        if (input.id !== undefined || input.url !== undefined) {
            throw new Error("engine targets by deployment id/url are not wired yet — pass a catalog model")
        }
        if (input.model === undefined) {
            throw new Error("account default model is not wired yet — pass a catalog model, e.g. Axon({ model: \"claude-sonnet-4-6\" })")
        }

        // The signal drives the fetch, never the JSON body (it isn't serializable).
        const { signal, ...request } = input.request
        const response = await opts.http.stream("/api/engine/stream", {
            model: input.model,
            request,
            ...(input.optimize !== undefined ? { optimize: input.optimize } : {}),
            ...(input.limit !== undefined ? { limit: input.limit } : {}),
        }, signal)

        for await (const frame of readSse(response, signal)) {
            if (frame.type === "error") {
                throw new Error(`engine stream failed: ${String(frame.message)}`)
            }
            yield frame as AxonEngineRawEvent
        }
    }

    return {
        stream,

        /**
         * Which model a selector actually runs on, without running anything.
         *
         * `Axon({ model: "auto" })` names a policy scored server-side, so this
         * is the only way a client can know what it is on before making a call
         * — what the TUI header resolves at session start. Same resolution
         * `stream` performs as its first step, so the answer matches what a
         * call would bill. Throws on an unresolvable selector, exactly as a
         * call would: never a silent fallback to some default.
         */
        async resolve(input: EngineResolve): Promise<ResolvedEngineModel> {
            return opts.http.post<ResolvedEngineModel>("/api/engine/resolve", {
                model: input.model,
                ...(input.optimize !== undefined ? { optimize: input.optimize } : {}),
                ...(input.limit !== undefined ? { limit: input.limit } : {}),
            })
        },

        /** Single-shot completion — drains the stream, returns the authoritative done response. */
        async request(input: EngineCloudStream): Promise<AxonEngineResponse> {
            for await (const event of stream(input)) {
                if (event.type === "done") return event.response
            }
            throw new Error("ENGINE_NO_DONE: stream ended without a done event")
        },
    }
}

export type EngineHandle = ReturnType<typeof Engine>

/** SSE framing for the engine stream — one JSON payload per `data:` line. */
async function* readSse(response: Response, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const reader = response.body!.getReader()
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
                if (!data) continue

                try {
                    yield JSON.parse(data) as Record<string, unknown>
                } catch {
                    continue // partial frame — protocol noise
                }
            }
        }
    } finally {
        signal?.removeEventListener("abort", onAbort)
    }
}
