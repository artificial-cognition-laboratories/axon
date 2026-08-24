import { AxonEngineEvent } from "./session/events/engine"

/**
 * Engine configuration — what the user puts in axon.config.ts. Either a
 * constructed definition (`Axon({ model })`, `Mock()`) or a declarative
 * reference (`{ provider: "axon", model: "claude-sonnet-4-6" }`). Both are
 * resolved to a live driver by the runtime's Engine() manager — the one
 * seam every boot path shares — via @arcforge/engines' resolveEngine().
 *
 * NOT an `axon.config.ts` field. `engine:` is deprecated there — an agent
 * declares `providers:` (sources) and `model:` (a cortex preference), and
 * resolution picks a driver per role from that pool. This type is the
 * INTERNAL shape a resolved driver is built from, which is why it still
 * exists and why nothing user-facing should reference it.
 *
 * @see https://axon.arclabs.it/docs/v2/agent/config
 */
export type EngineConfig = AxonEngineDef | EngineRef

/**
 * The declarative engine reference — pure data. What the managed base
 * workspace writes, what a model pick in the TUI serializes, and the form
 * the product contract promises: swap the reference, zero code changes.
 */
/** Requested reasoning effort. Unsupported engines accept and ignore it. */
export type EngineEffort = "low" | "medium" | "high" | "xhigh"

export type EngineRef =
    | { provider: "axon"; model?: string; effort?: EngineEffort; optimize?: EngineAutoWeights; limit?: EngineAutoLimits }
    | { provider: "openrouter"; model: string; effort?: EngineEffort }
    | { provider: "codex"; model?: string; effort?: EngineEffort }
    | { provider: "ollama"; model: string; effort?: EngineEffort }
    | { provider: "mock"; effort?: EngineEffort }

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
    /** Requested reasoning effort, if configured. Unsupported providers ignore it. */
    effort?: EngineEffort
    /**
     * Auto-selection weighting, when the constructor was given it. Only
     * meaningful alongside model: "auto".
     *
     * On the DEF rather than only inside the driver's closure because with
     * "auto" these are what decides the real model, so a client asking
     * "what am I running on" (cloud.engine.resolve) must be able to read
     * them — resolving without them answers for the default, not for this
     * agent.
     */
    optimize?: EngineAutoWeights
    /** Hard ceilings applied before scoring. Only meaningful alongside model: "auto". */
    limit?: EngineAutoLimits
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
    registry: {
        models: {
            /**
             * The merged public catalogue — one entry per canonical model,
             * every route it can be run through attached.
             *
             * Here because a provider now has to answer "what can I supply"
             * before any model is chosen, and the answer for a hosted route
             * lives in the registry. Same reason the rest of this type
             * exists: @arclabs/cloud depends on this package, so the client
             * cannot be imported and the slice engines need is spelled at
             * the seam instead.
             */
            all(): Promise<CloudModelCatalog>

            /**
             * Did the last `all()` answer come off disk rather than the wire?
             *
             * Part of the seam because the boot trace reports it: a slow boot
             * has to be able to say whether it paid for a cold catalogue
             * fetch. Optional so an embedder supplying its own minimal cloud
             * stub is not forced to implement caching it does not do.
             */
            wasCached?(): boolean
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

/**
 * The registry's merged model catalogue, as engines consume it.
 *
 * Structurally the same shape @arclabs/cloud returns; spelled here for the
 * same reason as EngineCloud itself. `modality` is OpenRouter's own
 * `"text+image->text"` string — carried rather than pre-parsed so the
 * classification table stays in one place.
 */
export type CloudModelCatalog = {
    models: Array<{
        id: string
        name: string
        context: number
        /** e.g. "text+image->text". Absent when the upstream source omits it. */
        modality?: string
        routes: Array<{ via: string; model: string }>
    }>
    /** A source that failed — never silently a shorter list. */
    failures: Array<{ source: string; message: string }>
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
    /**
     * Absent on the generate driver, deliberately.
     *
     * Every driver this package has ever built is a generate driver, and
     * requiring an existing one to declare `kind: "generate"` would break
     * every published adapter for a discriminant the union can infer from
     * `stream` being present. The two new kinds declare theirs.
     */
    readonly kind?: "generate"
    stream(req: AxonEngineRequest): AsyncGenerator<AxonEngineRawEvent>
}

/**
 * What a provider builds for one resolved capability.
 *
 * A union keyed on the capability's type, mirroring KernelEngine on the ABI:
 * the kernel wraps whichever of these it is given with telemetry and hands
 * the matching handle to the cognet. One construction seam
 * (`AxonProvider.create`) rather than three, because who picked the model is
 * not the transport's business and splitting the seam would mean three places
 * every boot path has to agree about.
 *
 * These are DUMB. A driver knows how to talk to one model; it does not parse
 * a grammar, touch the bus, or commit anything — the runtime's Engine()
 * manager owns all of that, so the AIR protocol is implemented exactly once.
 */
export type AxonDriver = AxonEngineDriver | AxonTransformDriver | AxonStreamDriver

/**
 * One shot in, one shot out.
 *
 * `input` and the result are BOTH unknown here, deliberately: what a depth
 * map or an embedding means is the cognet's business, and a driver contract
 * that named those shapes would be the transport layer growing an opinion
 * about tensor semantics. Adapters per model family are where that knowledge
 * lives.
 */
export type AxonTransformDriver = {
    readonly kind: "transform"
    transform(input: unknown, opts?: { onProgress?: (progress: { fraction?: number; message?: string }) => void }): Promise<unknown>
}

/**
 * A stateful sequential feed.
 *
 * `open()` is where the expensive part happens once — building the execution
 * graph — and every push after it shares the model's hidden state. That is
 * the whole reason this is not a transform: Silero's LSTM is what lets it
 * tell a pause mid-sentence from silence, and N independent calls destroy it.
 */
export type AxonStreamDriver = {
    readonly kind: "stream"
    open(): AxonDriverSession
}

export type AxonDriverSession = {
    push(input: unknown): Promise<unknown>
    reset(): void
    close(): void
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
    stream: (req: AxonEngineCall) => AsyncGenerator<AxonEngineEvent>
    /** Single-shot completion. Same response shape as the stream's done event. */
    request: (req: AxonEngineCall) => Promise<AxonEngineResponse>
}

/**
 * One call through the engine MANAGER — the driver request plus the grammar
 * to parse the reply with.
 *
 * Protocol lives here rather than on AxonEngineRequest because a driver is a
 * dumb token pipe that never parses anything; only the manager runs the AIR
 * parser. It is per-call rather than per-runtime so one cognet can hold a
 * cortex loop on "classic" and a one-shot classification on "raw" against the
 * same kernel.
 *
 * Omitted means the manager's default. The caller that rendered the context
 * owns this: a cognet rendering one grammar while the kernel parses another
 * would silently discard every block the model emitted.
 */
export type AxonEngineCall = AxonEngineRequest & {
    /**
     * Which of the cognet's declared roles serves this call.
     *
     * The brain's own word — "main", "percept", "compress" — never a model or
     * a provider. What fills it was decided at boot against whatever the user
     * declared, so the same source runs on a frontier route for one person
     * and a local model for another with nothing in the cognet changing.
     *
     * Omitted uses the agent's single `engine:`, which is what every cognet
     * that never declared roles does.
     */
    role?: string

    /** The output grammar to parse the reply with. Must match what the caller rendered. */
    protocol?: AirProtocolName
    /**
     * The shape this response must produce, already compiled.
     *
     * Structural rather than a named type because @arcforge/types must not
     * depend on @arcforge/air (which depends on it) — the compiled contract
     * is `CompiledOutput` there, and this is the same shape spelled at the
     * seam. The engine enforces it and retries a response that misses it; no
     * cognet ever sees the check.
     */
    output?: {
        declaration: string
        check(script: string): readonly { message: string; line?: number }[]
    }
    /** Attempts after a response fails `output`. Ignored without one. Default 2. */
    retries?: number
    /**
     * Re-render the request from the session, for a retry.
     *
     * A retry has to show the model its own rejected reply and the correction
     * it earned, and those are session ENTRIES — so the only honest way to put
     * them in front of the model is to render the document again now that they
     * exist. Appending the correction to the finished messages instead put a
     * `<system>` block AFTER `</timeline>`, outside every structure the
     * context had just taught, in the highest-attention position on the wire.
     * A model shown a floating block immediately before being told not to emit
     * floating blocks does the obvious thing.
     *
     * Supplied by the caller because rendering belongs to cognition: the
     * engine owns the retry budget and knows a reply failed, but has no view
     * of a timeline and must not grow one.
     *
     * Optional — a caller that renders nothing (an internal one-shot) has no
     * document to re-render, and the engine falls back to reusing the
     * messages it was given.
     */
    rerender?(): Promise<AxonEngineMessage[]>
}

/**
 * The named AIR output grammars. Declared here, not imported from
 * @arcforge/air: the kernel ABI is ring 0 and must not depend on a library
 * above it. The two are kept in step by AirProtocolName in air/types.ts
 * being assignable to this — one is the library's, this is the contract's.
 */
export type AirProtocolName = "classic" | "raw"

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
