import type { AxonDriver, EngineCapability, ProviderEntry } from "@arcforge/types"

/**
 * What a provider is, now that a model is chosen at boot rather than written
 * into a config.
 *
 * Three verbs, and the split between them is the whole inversion this
 * redesign makes: `catalogue()` and `resolve()` answer "what can I supply",
 * `create()` is called AFTER resolution with the capability that won. The
 * old `Ollama({ model })` shape took the model at construction, which is
 * precisely the decision that has moved.
 *
 * `create()` returns whichever DRIVER KIND the capability declared —
 * generate, transform, or stream. One construction seam rather than three:
 * splitting it would mean three places every boot path has to agree about,
 * and the capability already says which kind it is. The drivers stay dumb
 * either way; who picked the model is not the transport's business.
 */
export type AxonProvider = {
    /** Route name — "axon", "codex", "ollama", "huggingface", "openrouter", "mock". */
    name: string

    /**
     * Everything this source can supply RIGHT NOW.
     *
     * For a hosted route that is the published catalogue. For a local one it
     * is what is actually present on the machine — never a download menu. A
     * shelf of models a user could install is a thing a picker shows, not a
     * statement about what this agent can bind, and conflating them produces
     * a role that resolves at prepare and dies at the first call.
     *
     * Throws when the source cannot be reached. The gatherer turns that into
     * a visible failure rather than a quietly shorter list — a user whose
     * Ollama is down must be told that, not handed an agent that silently
     * fell back to the cloud.
     */
    catalogue(): Promise<EngineCapability[]>

    /**
     * Verify one specific reference this provider was not able to enumerate.
     *
     * Exists because two of the sources that matter are unbounded: Hugging
     * Face hosts more weights than anyone can list, and Ollama's registry
     * accepts any name whether or not it is on the curated shelf. Null when
     * the reference is unknown or unusable — a refusal, never a guess.
     */
    resolve(ref: string): Promise<EngineCapability | null>

    /**
     * Build the driver for a capability this provider supplied.
     *
     * Cheap for a hosted route (a closure over a URL). Expensive for local
     * weights, where this is where loading happens — which is why it runs at
     * boot, before the cognet's first wake, and never at a call site.
     */
    create(capability: EngineCapability): AxonDriver

    /**
     * When this provider last answered from a cache rather than the wire.
     *
     * Optional because most providers do not cache: Ollama is a localhost
     * call cheaper than the disk read that would cache it. Present on the
     * hosted routes, whose catalogue is a public document fetched over the
     * network and cached to disk — see @arcforge/cloud's CatalogueStore.
     *
     * Read by the boot trace, never by resolution: a cached catalogue and a
     * fresh one must resolve identically or the cache is a bug.
     */
    readonly cachedAt?: number | undefined
}

/** What every provider factory receives — the user's declaration plus runtime resources. */
export type LocalRuntime = {
    catalogue(): Promise<EngineCapability[]>
    run(model: string, prompt: string): Promise<string>
}

export type ProviderResources = {
    entry: ProviderEntry
    /** Resolved agent environment. No process.env reads inside a provider. */
    env: Record<string, string | undefined>
}
