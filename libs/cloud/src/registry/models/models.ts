import type { HttpClient } from "../../platform/http"
import { CatalogueStore } from "./store"
import type { AxonModelInfo, ModelCatalog, ModelInfo } from "./types"

type ModelsOpts = {
    http: HttpClient
    /**
     * Where a background revalidation failure goes. Absent, a stale-serve
     * refresh that fails is dropped — acceptable only because the caller
     * already has a usable answer, never because the error does not matter.
     */
    onError?: (cause: unknown) => void
}

/**
 * Model catalogs — public lists for the model picker, one per way of
 * running a model through Axon. All three are served by the backend
 * (which owns the upstream fetches, normalization, and any provider keys)
 * — this client is a thin cached projection.
 *
 * Registry semantics: no auth, same answer for every user. Headless:
 * plain data out, no reactivity — clients wrap as they like.
 */
export function Models(opts: ModelsOpts) {
    const memory = new Map<string, { at: number; models: unknown }>()
    const TTL_MS = 5 * 60_000
    const store = CatalogueStore(opts.onError ? { onError: opts.onError } : {})

    /** Whether the last answer for a key came off disk — read by boot tracing. */
    const hits = new Map<string, boolean>()

    /**
     * Two tiers, and they answer different questions.
     *
     * MEMORY serves a long-lived process asking repeatedly (the TUI's model
     * picker). DISK serves the case that actually costs: a fresh process per
     * agent boot, where an in-memory cache is empty by construction and the
     * fetch sits on the critical path ahead of the capsule.
     */
    async function cached<T>(key: string, load: () => Promise<T>, opts?: { shared?: boolean }): Promise<T> {
        const hit = memory.get(key)
        if (hit && Date.now() - hit.at < TTL_MS) {
            hits.set(key, true)
            return hit.models as T
        }

        /**
         * `shared: false` keeps a response OUT of the on-disk cache.
         *
         * That cache is one file per MACHINE, keyed by catalogue name and
         * nothing else — its own doc says it is safe precisely because
         * "model catalogues are PUBLIC, unauthenticated, and byte-identical
         * for every user". That holds for the axon and openrouter catalogues
         * and does NOT hold for the merged one: `/api/registry/models`
         * attaches codex routes reflecting the CALLER's own subscription
         * entitlement, which the backend states plainly and marks
         * `Cache-Control: private`.
         *
         * Writing it to the shared file made one user's entitlement the
         * machine's answer — an authenticated read populated the file and
         * every later caller, anonymous ones included, was served their
         * codex routes. Memory caching still applies: that map lives and
         * dies with this client, so it can only ever serve back what this
         * caller already fetched.
         */
        if (opts?.shared === false) {
            const value = await load()
            memory.set(key, { at: Date.now(), models: value })
            hits.set(key, false)
            return value
        }

        const read = await store.get<T>(key, async () => ({ value: await load() }))
        memory.set(key, { at: Date.now(), models: read.value })
        hits.set(key, read.cached)
        return read.value
    }

    return {
        /**
         * Did the last read of this catalogue avoid the wire?
         *
         * Exists for the boot trace: "inference took 280ms" is not
         * actionable, "inference took 280ms and the catalogue was cold" is.
         */
        wasCached(key: "all" | "axon" | "openrouter" = "all"): boolean {
            return hits.get(key) ?? false
        },

        /** The merged picker catalog — one entry per canonical model, all routes (axon/openrouter/codex) attached. */
        all(): Promise<ModelCatalog> {
            // NOT disk-cached: this catalogue is per-caller (codex routes are
            // the caller's own entitlement), so it must never reach the
            // machine-wide file. See `cached`.
            return cached("all", () => opts.http.get<ModelCatalog>("/api/registry/models"), { shared: false })
        },

        /** The billed Axon catalog — ids + user-facing per-1M pricing (ledger minor units). */
        axon(): Promise<AxonModelInfo[]> {
            return cached("axon", () => opts.http.get<AxonModelInfo[]>("/api/registry/models/axon"))
        },

        /** OpenRouter's public catalog, chat-capable models only, USD per 1M. Throws on failure. */
        openrouter(): Promise<ModelInfo[]> {
            return cached("openrouter", () => opts.http.get<ModelInfo[]>("/api/registry/models/openrouter"))
        },
    }
}

export type ModelsHandle = ReturnType<typeof Models>
