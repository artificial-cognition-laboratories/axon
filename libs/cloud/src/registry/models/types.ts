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

/** One source failing degrades into a visible failure entry, never an empty list. */
export type ModelCatalog = {
    models: RegistryModel[]
    failures: Array<{ source: "openrouter" | "codex"; message: string }>
}
