import { AxonEngineEvent } from "./session/events/engine"

/**
 * Engine configuration — what the user puts in axon.config.ts. Either a
 * constructed definition (`Axon({ model })`, `Mock()`) or a declarative
 * reference (`{ provider: "axon", model: "claude-sonnet-4-6" }`). Both are
 * resolved to a live driver by the runtime's Engine() manager — the one
 * seam every boot path shares — via @arcforge/engines' resolveEngine().
 *
 * ```ts
 * export default defineAgent({
 *     engine: { provider: "axon", model: "claude-sonnet-4-6" },
 *     // or, for advanced wiring:
 *     // engine: Axon({ model: "claude-sonnet-4-6", url: "ws://localhost:8787" }),
 * })
 * ```
 *
 * @see https://axon.arclabs.it/docs/v2/api/config/engine
 */
export type EngineConfig = AxonEngineDef | EngineRef

/**
 * The declarative engine reference — pure data. What the managed base
 * workspace writes, what a model pick in the TUI serializes, and the form
 * the product contract promises: swap the reference, zero code changes.
 */
export type EngineRef =
    | { provider: "axon"; model?: string; optimize?: EngineAutoWeights; limit?: EngineAutoLimits }
    | { provider: "openrouter"; model: string }
    | { provider: "codex"; model?: string }
    | { provider: "ollama"; model: string }
    | { provider: "mock" }

/**
 * Axon({ model: "auto" }) weighting — resolved server-side against a
 * curated model table (never shipped client-side, so curation updates
 * reach every agent using "auto" with no client update). Unset axes
 * contribute 0; weights are normalized to sum to 1 at resolution time, so
 * `{ cost: 2, intelligence: 1 }` and `{ cost: 0.5, intelligence: 0.25 }`
 * are equivalent.
 */
export type EngineAutoWeights = { cost?: number; intelligence?: number; speed?: number }

/** Hard ceilings applied before scoring — a candidate that fails a limit is never a possible pick, at any weight. */
export type EngineAutoLimits = { cost?: number }

/** An engine definition: named, constructed by the runtime with resources. */
export type AxonEngineDef = {
    /** Provider name — telemetry and error messages ("axon", "ollama", "mock"). */
    name: string
    /**
     * The model id the constructor was given, if any (e.g. Codex({ model:
     * "gpt-5.6-terra" }) → "gpt-5.6-terra") — static, known at config-read
     * time, no engine call needed. Every constructor in @arcforge/engines
     * stamps this from its own `options.model`. "auto" (Axon({ model:
     * "auto" })) is the one value that ISN'T the real model — it only
     * resolves server-side, per call; a client showing it should say so.
     */
    model?: string
    create(res: EngineResources): AxonEngineDriver
}

/** What the runtime hands an engine def at construction. */
export type EngineResources = {
    /** Resolved agent environment — API keys, base URLs. No process.env reads in drivers. */
    env: Record<string, string | undefined>
    /**
     * The runtime's cloud client — engines call what they need (vault
     * connection tokens today; engine resolution and the Cognos connection
     * when the Axon engine is ported). Provider tokens are minted
     * server-side and cached until expiry, so per-request resolution is
     * free and rotation never rebuilds a driver.
     */
    cloud: EngineCloud
}

/**
 * Hand-written contract for the slice of AxonCloudClient engines consume —
 * same pattern as EngineConnection in handle.ts (@arclabs/cloud depends on
 * this package, so the type can't be imported; the real client satisfies
 * this structurally). Grow it deliberately as engines need more surface.
 */
export type EngineCloud = {
    user: {
        vault: {
            connections: {
                openai: {
                    /** Narrow short-lived Codex token — refresh material never reaches a host. Throws when the account isn't connected. */
                    token(): Promise<CodexToken>
                }
                openrouter: {
                    /** The user's vaulted OpenRouter API key, minted as a narrow token. Throws when the account isn't connected. */
                    token(): Promise<{ accessToken: string; expiresAt: number }>
                }
            }
        }
    }
    cloud: {
        engine: {
            /**
             * Managed inference — the backend routes to the target model
             * server-side, meters usage from the provider's own accounting,
             * and debits the caller's ledger (markup is enforced where the
             * money is, never client-side). The server assembles the
             * terminal done event, so its meta (tokens, cost) is
             * authoritative — it IS the ledger entry.
             */
            stream(input: EngineCloudStream): AsyncGenerator<AxonEngineRawEvent>
            /** Single-shot completion — drains the stream, returns the done response. */
            request(input: EngineCloudStream): Promise<AxonEngineResponse>
        }
    }
}

/** One managed-inference call — the request plus how to route it. */
export type EngineCloudStream = {
    request: AxonEngineRequest
    /** Catalog model ID e.g. "claude-sonnet-4-6", or "auto" — server-resolved, see EngineAutoWeights. Omit for the account default. */
    model?: string
    /** Only meaningful when model is "auto" — ignored otherwise. */
    optimize?: EngineAutoWeights
    /** Only meaningful when model is "auto" — ignored otherwise. */
    limit?: EngineAutoLimits
    /** Engine deployment ID — pin a specific engine by registry ID (e.g. "helios"). */
    id?: string
    /** Direct WebSocket URL override — local dev / self-hosted harnesses only. */
    url?: string
}

/** What a Codex driver needs for one call — deliberately no refresh material. */
export type CodexToken = {
    accessToken: string
    /** chatgpt_account_id — sent as a header alongside the bearer token. */
    accountId: string
    /** unix ms — when this access token dies (the client caches until then). */
    expiresAt: number
}

/**
 * The driver contract — what adapter authors implement. A dumb token pipe:
 * messages in, raw deltas out, one terminal done. No AIR parsing, no bus,
 * no blocks — the runtime's Engine() manager owns all of that, so the
 * grammar is implemented exactly once.
 *
 * Errors: drivers THROW on failure (network, auth, provider error). There
 * is no error event — a failed call is a runtime error the manager
 * handles, never model-visible content.
 */
export type AxonEngineDriver = {
    stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent>
}

/**
 * Raw wire events from a driver.
 * text:delta     — a chunk of model output (AIR-formatted text, unparsed)
 * thinking:delta — a chunk of provider-native reasoning, when exposed
 * done           — terminal; carries the authoritative full response
 */
export type AxonEngineRawEvent =
    | { type: "text:delta"; content: string }
    | { type: "thinking:delta"; content: string }
    | { type: "done"; response: AxonEngineResponse }

/**
 * The engine contract the kernel consumes: parsed block events
 * (AxonEngineEvent). Implemented by the runtime's Engine() manager —
 * driver deltas run through the one Air parser, telemetry is emitted
 * around every call. Loop defs never see a raw driver.
 */
export type AxonEngine = {
    /** Stream block events in real time, terminated by a single agent:done. */
    stream: (req: AxonEngineRequest) => AsyncGenerator<AxonEngineEvent>
    /** Single-shot completion. Same response shape as the stream's done event. */
    request: (req: AxonEngineRequest) => Promise<AxonEngineResponse>
}

export type AxonEngineMessage = {
    role: "user" | "assistant" | "system"
    content: string
}

/** Request payload passed to an engine. */
export type AxonEngineRequest = {
    messages: AxonEngineMessage[]
    model?: string
    maxTokens?: number
    temperature?: number
    /** First-class cancellation — engines must abort in-flight work when fired. */
    signal?: AbortSignal
}

/**
 * The authoritative result of one engine call — returned by request() and
 * carried on the stream's `done` event.
 */
export type AxonEngineResponse = {
    /** Full raw model output — what the AIR parser consumes. */
    text: string
    /** Full reasoning trace, when the provider exposes it. */
    thinking?: string
    /**
     * Why generation ended.
     * "end"    — model finished naturally
     * "length" — truncated at maxTokens; the kernel treats trailing blocks as incomplete
     * "abort"  — cancelled via the request signal
     */
    stopReason: "end" | "length" | "abort"
    meta: AxonEngineMeta
}

/** Per-call metadata — the billing and observability payload. */
export type AxonEngineMeta = {
    provider: string
    model: string
    /** Provider-authoritative request identifier, when exposed. */
    requestId?: string
    /** Absent when the provider does not report usage — never fabricated as zero. */
    tokens?: {
        in: number
        out: number
        total: number
        cachedIn?: number
        reasoning?: number
    }
    /** USD. Absent means the engine cannot price the call (local inference) — not zero. */
    cost?: { in: number; out: number; total: number }
    durationMs: number
    /** Time to the first provider delta, when observable. */
    firstTokenMs?: number
}

/** Stable failure vocabulary shared by drivers, the kernel log, and clients. */
export type AxonEngineFaultCode =
    | "EMPTY_RESPONSE"
    | "TRANSPORT"
    | "RATE_LIMIT"
    | "AUTH"
    | "AUTH_NOT_CONNECTED"
    | "QUOTA"
    | "INVALID_REQUEST"
    | "PROTOCOL"
    | "ABORTED"
    | "UNKNOWN"

/** Serializable engine failure — errors cross process/event boundaries as data. */
export type AxonEngineFault = {
    code: AxonEngineFaultCode
    message: string
    retryable: boolean
    provider: string
    model?: string
    status?: number
    retryAfterMs?: number
}
