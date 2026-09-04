/**
 * A model in the billed Axon catalog. Pricing is what the USER pays —
 * per 1M tokens in ledger minor units, markup already applied server-side.
 */
export type AxonModelInfo = {
    /** Catalog id, e.g. "anthropic/claude-sonnet-4.6" — what goes in Axon({ model }). */
    id: string
    pricing: { inPerMTok: number; outPerMTok: number }
}

/**
 * A chat-capable model in a provider's public catalog, normalized.
 * Plain data — display formatting (ctx strings, $/M) is the client's job.
 */
export type ModelInfo = {
    /** Provider-qualified id, e.g. "anthropic/claude-sonnet-4-6" */
    id: string
    provider: "openrouter"
    name: string
    description: string
    /** Context window in tokens. */
    context: number
    /** USD per 1M tokens. Absent when the provider doesn't price the model. */
    pricing?: { prompt: number; completion: number }
}

// ── Merged picker catalog ─────────────────────────────────────────────────────

/**
 * One canonical model with every route it can be run through — THE picker
 * surface. The model is the pick; the route is an attribute of the pick.
 */
export type RegistryModel = {
    /** Canonical id — openrouter-style "vendor/slug". */
    id: string
    vendor: string
    name: string
    description: string
    /** Context window in tokens. 0 when the source doesn't report one (codex-only ids). */
    context: number
    /**
     * Upstream's modality string, e.g. "text+image->text".
     *
     * How a runtime classifies this model's engine shape — what lets a
     * cognet declare a role that needs image input and have it resolve
     * against the catalogue. Absent when the source does not report one, and
     * a model with no modality is left out of engine resolution rather than
     * assumed to be text-only.
     */
    modality?: string
    routes: RegistryRoute[]
}

export type RegistryRoute =
    /** Billed Axon inference — what the USER pays (ledger minor units per 1M, markup applied). */
    | { via: "axon"; model: string; pricing: { inPerMTok: number; outPerMTok: number } }
    /** BYOK OpenRouter — raw upstream USD per 1M. */
    | { via: "openrouter"; model: string; pricing?: { prompt: number; completion: number } }
    /** BYOK ChatGPT subscription (Codex OAuth) — no per-token price. */
    | { via: "codex"; model: string }

/**
 * How reachable a catalogue source was on the request that produced this
 * catalogue.
 *
 *   live  — fetched just now
 *   stale — serving a previous good answer because the refresh failed. The
 *           MODELS ARE GOOD; only the refresh was not.
 *   down  — nothing to serve for this source
 */
export type SourceState = "live" | "stale" | "down"

/**
 * One source failing degrades into a visible entry, never an empty list.
 *
 * `source` is an open string, matching the backend's own vocabulary: a route's
 * `via` is DATA there (a new BYOK provider is a table row, not a type edit),
 * and a closed union here would make adding one a compile error in every
 * client for something the wire already carries fine.
 */
export type ModelCatalog = {
    models: RegistryModel[]
    /**
     * Sources with nothing current to offer. A source serving cached data
     * through a blip is NOT here — it contributed real, working models, and
     * reporting it as failed is what made a one-second outage read to users
     * as a dead credential.
     */
    failures: Array<{ source: string; message: string }>
    /**
     * Per-source health for every source consulted — the separation that
     * keeps a transient network observation from being cached as though it
     * were a fact about the catalogue.
     *
     * Optional because a client may be talking to a backend that predates it;
     * absent means "not reported", never "everything is fine".
     */
    sources?: Array<{
        source: string
        state: SourceState
        /** Why the most recent fetch failed. Present on `stale` too. */
        reason?: string
        /** When the served data was fetched. */
        at?: number
    }>
}
