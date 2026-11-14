import { parseSpecifier } from "../specifier"
import { record } from "../record"
import { fitFor, order, type ModelSort } from "../fit"
import type { CatalogT } from "../catalog"
import type { ModelCapability, ModelRecord } from "../types"
import type { MachineT } from "../../machine"
import type { InventoryT } from "../inventory"
import type { ResidenceT } from "../residence"

export type SearchInput = {
    query: string
    capability?: ModelCapability
    sort?: ModelSort
    /** Drop weights that certainly will not run here. Unknown sizes survive. */
    fitsOnly?: boolean
    runnableOnly?: boolean
}

/** Own catalogue searches and their machine-specific presentation. */
export function Discovery(opts: { catalog: CatalogT; machine: MachineT; inventory: InventoryT; residence: ResidenceT }) {
    function mark(model: ModelRecord): ModelRecord {
        // Matched on the REPOSITORY, not the raw id. A cached specifier
        // carries the pin and the inner path — `…@main/onnx/model.onnx` —
        // while a listing names the repository alone, so a prefix comparison
        // of the two misses and a downloaded model reads as available.
        const wanted = parseSpecifier(model.id)
        const local = opts.inventory.current.find(entry => {
            if (model.id.includes("@") || model.id.split("/").length > 2) return entry.id === model.id
            const parsed = parseSpecifier(entry.id)
            return parsed.name === wanted.name && parsed.owner === wanted.owner
        })
        if (!local) return model
        return {
            ...model,
            runtime: local.runtime,
            bytes: local.bytes,
            path: local.path,
            cached: true,
            resident: opts.residence.has(local.id),
        }
    }

    /**
     * Stamp every row with how it sits against THIS machine, and order them.
     *
     * Judged here rather than in the catalogue because a catalogue row is the
     * same on every box and a fit is not: the ceiling is the declared budget
     * where there is one, the card where there is not, and it changes the
     * moment someone moves a slider.
     *
     * A named closure for the same reason `refresh` is one — the handle is
     * invoked detached over the socket, so a verb reaching a sibling through
     * `this` finds nothing.
     */
    function judge(models: ModelRecord[], sort: ModelSort, fitsOnly: boolean): ModelRecord[] {
        const capacity = opts.machine.hardware.current()
        const ceiling = opts.machine.budget.current() ?? capacity.vram

        const stamped = models.map(model => ({
            ...model,
            fit: fitFor(model.bytes ?? model.estimatedBytes, ceiling),
        }))

        // "unknown" survives the filter deliberately. A Hugging Face listing
        // publishes no size, so hiding what cannot be judged would hide most
        // of the registry — the filter is there to remove what definitely will
        // not run, not everything not proven to.
        const kept = fitsOnly ? stamped.filter(model => model.fit !== "over") : stamped
        return order(kept, sort)
    }

    return {
        async search(input: string | SearchInput): Promise<ModelRecord[]> {
            // One argument crosses the wire (see Dispatch), so a caller with
            // several passes an object. A bare string is the ergonomic form and
            // means the same thing unscoped.
            const { query, capability, sort, fitsOnly, runnableOnly } = normalise(input)

            /*
             * `fitsOnly` is asked of the REGISTRY as well as applied here.
             *
             * It means "shows me what runs on this machine", and there are two
             * ways a model fails that: no adapter can execute its format, and
             * it does not fit in video memory. The second is local arithmetic;
             * the first is a property of the repository, and filtering it
             * after the fact meant a page of a hundred rows arrived with a
             * dozen usable ones on it. Asking the registry returns a hundred
             * usable ones instead.
             */
            const hit = opts.catalog.cached(query, capability, runnableOnly)
            if (hit.length > 0 && !opts.catalog.stale(query, capability, runnableOnly)) {
                // Warm queries are refreshed explicitly through searchFresh.
                return judge(hit.map(mark), sort, fitsOnly)
            }
            const fresh = (await opts.catalog.refresh(query, capability, runnableOnly))?.map(mark) ?? []
            return judge(fresh, sort, fitsOnly)
        },

        /**
         * The next page of a search, appended to what is already known.
         *
         * Separate from `search` because "give me more" and "give me this" are
         * different questions: one continues a cursor, the other starts over.
         * Collapsing them would make a re-render silently pull another page.
         */
        async more(input: string | SearchInput): Promise<ModelRecord[]> {
            const { query, capability, sort, fitsOnly, runnableOnly } = normalise(input)
            const models = (await opts.catalog.more(query, capability, runnableOnly))
                ?? opts.catalog.cached(query, capability, runnableOnly)
            return judge(models.map(mark), sort, fitsOnly)
        },

        /** Whether another page exists for this search. */
        hasMore(input: string | SearchInput): boolean {
            const { query, capability, fitsOnly, runnableOnly } = normalise(input)
            return opts.catalog.hasMore(query, capability, runnableOnly)
        },

        /**
         * One repository in full — metadata, weight files, and its card.
         *
         * Marked like a search row, so a detail page knows whether this
         * machine already holds it without a second lookup.
         */
        async at(specifier: string): Promise<ModelRecord & {
            weights: string[]
            sizes: Record<string, number>
            readme: string | null
            likes: number | null
            updatedAt: number | null
            license: string | null
            library: string | null
            baseModel: string | null
            datasets: string[]
            tags: string[]
            storage: number | null
            params: number | null
        }> {
            /*
             * Ollama models are not Hugging Face repositories.
             *
             * `repo()` strips an `hf:` prefix and asks huggingface.co for
             * whatever is left, so every Ollama specifier went to the wrong
             * registry and came back 401 — a detail page that never resolved
             * and could not say why. Ollama publishes no card API, so what is
             * knowable is what the library listing already gave us.
             */
            const parsedRef = parseSpecifier(specifier)
            if (parsedRef.scheme === "ollama") {
                const known = opts.inventory.current.find(entry => entry.id === specifier)
                return {
                    ...(known ?? record({
                        model: specifier,
                        bytes: null,
                        runtime: "ollama",
                        capability: "chat",
                        cached: false,
                        resident: false,
                    })),
                    weights: [],
                    sizes: {},
                    readme: null,
                    likes: null,
                    updatedAt: null,
                    license: null,
                    library: "ollama",
                    baseModel: null,
                    datasets: [],
                    tags: [],
                    storage: null,
                    params: null,
                }
            }

            // Through the catalogue, so the card is cached on disk and shared
            // by every process that asks — the platform, the extension, and a
            // desktop panel all pay for one fetch rather than one each.
            const detail = await opts.catalog.detail(specifier)
            const marked = mark(record({
                model: detail.id,
                bytes: null,
                runtime: null,
                type: detail.type,
                // Carried explicitly. Without it `record()` fell to its "other"
                // default and a detail page contradicted the listing that
                // opened it — the same model reading speech in one view and
                // other in the next.
                capability: detail.capability,
                downloads: detail.downloads,
                cached: false,
                resident: false,
            }))
            // Everything the registry knows, carried through. `likes` and
            // `updatedAt` were computed by `repo()` and then dropped here, so
            // a detail page showed a dash for figures that had already been
            // fetched — which is worse than not fetching them.
            return {
                ...marked,
                weights: detail.weights,
                sizes: detail.sizes,
                readme: detail.readme,
                likes: detail.likes,
                updatedAt: detail.updatedAt,
                license: detail.license,
                library: detail.library,
                baseModel: detail.baseModel,
                datasets: detail.datasets,
                tags: detail.tags,
                storage: detail.storage,
                params: detail.params,
            }
        },

        /** Fetch one query, bypassing the cache. What a "check again" gesture calls. */
        async searchFresh(query: string): Promise<ModelRecord[]> {
            return (await opts.catalog.refresh(query))?.map(mark) ?? opts.catalog.cached(query).map(mark)
        },

    }
}
export type DiscoveryT = ReturnType<typeof Discovery>

function normalise(input: string | SearchInput): Required<Omit<SearchInput, "capability">> & { capability?: ModelCapability } {
    const given = typeof input === "string" ? { query: input } : input
    return {
        query: given.query,
        ...(given.capability !== undefined ? { capability: given.capability } : {}),
        sort: given.sort ?? "relevance",
        fitsOnly: given.fitsOnly ?? false,
        runnableOnly: given.runnableOnly ?? given.fitsOnly ?? false,
    }
}

