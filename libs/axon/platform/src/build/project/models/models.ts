import { err } from "@arcforge/err"
import type { ModelRef } from "@arcforge/types"
import { Fetch } from "./fetch"
import { parseModels, type ParsedModel } from "./specifier"
import { ModelStore, type ModelStoreT, type StoredModel } from "./store"

/**
 * Models — a cognet's declared weights, from specifier to absolute path.
 *
 * Owns the whole small toolchain: parse what was declared, reconcile it
 * against the machine's cache, fetch what is missing, and hand back the map
 * the kernel gives the brain.
 *
 * It knows nothing about ML. A weight is a file with a hash and a name the
 * cognet chose; whether those bytes are a VAD, a language model or a lookup
 * table is the cognet's business, and the runtime that executes them is an
 * ordinary npm dependency the cognet imports. This is an asset store that
 * happens to be used for models.
 */

type ModelsOpts = {
    /** Override the cache root — tests and deployment images both use this. */
    store?: ModelStoreT
}

export type ResolveResult = {
    /** Local name → absolute path. What the blueprint carries and the kernel hands over. */
    paths: Record<string, string>
    /** Models actually downloaded this run — everything else was already cached. */
    fetched: string[]
}

export function Models(opts: ModelsOpts = {}) {
    const store = opts.store ?? ModelStore()
    const fetcher = Fetch({ store: store })

    return {
        get store() {
            return store
        },

        /** Parse without touching the network — what `--frozen` inspects. */
        parse(models: Record<string, ModelRef> | undefined): ParsedModel[] {
            return parseModels(models)
        },

        /**
         * Which declared models are NOT already on this machine.
         *
         * Only decidable without the network for PINNED refs, whose hash is
         * their address. An unpinned model has to ask the registry what its
         * hash is before the cache can be consulted, so it always counts as
         * missing here — conservative in the safe direction: the worst case
         * is a HEAD request that finds it cached after all.
         */
        missing(models: ParsedModel[]): ParsedModel[] {
            return models.filter(model => {
                if (!model.sha256) return true
                return !store.has(model.sha256, model.file.split("/").pop()!)
            })
        },

        /**
         * Resolve one model that is a SET of files, to the directory holding it.
         *
         * The counterpart of `resolve` for repositories rather than weights.
         * Deliberately singular: a set is chosen by a person or a planner
         * looking at one repository's file list, where `resolve` reconciles a
         * whole cognet's declarations at once.
         *
         * What comes back is a DIRECTORY, and that is the point — a runtime
         * that needs a tokeniser beside its weights is handed the layout it
         * expects, and `ResolveResult.paths` stays `name → path` for both
         * kinds without a consumer learning the difference.
         */
        async resolveSet(
            repo: { host: "hf"; repo: string; rev: string; key: string },
            files: string[],
            primary: string,
            resolveOpts: {
                signal?: AbortSignal
                onDownload?: (model: ParsedModel) => void
                onProgress?: (progress: { model: ParsedModel; received: number; total: number | null }) => void
                traits?: ParsedModel["traits"]
            } = {},
        ): Promise<StoredModel> {
            return await fetcher.manifest({ repo: repo, files: files, primary: primary, options: resolveOpts, traits: resolveOpts.traits })
        },

        /**
         * Resolve every declared model to an absolute path, fetching what is
         * absent.
         *
         * Sequential rather than parallel: these are large files, and ten
         * concurrent 150MB downloads is a worse experience than ten in a row
         * on every connection that is not a datacentre.
         */
        async resolve(
            models: Record<string, ModelRef> | undefined,
            resolveOpts: {
                frozen?: boolean
                signal?: AbortSignal
                onDownload?: (model: ParsedModel) => void
                /** Bytes as they arrive. Forwarded straight to the fetcher — see FetchOpts. */
                onProgress?: (progress: { model: ParsedModel; received: number; total: number | null }) => void
            } = {},
        ): Promise<ResolveResult> {
            const parsed = parseModels(models)
            if (parsed.length === 0) return { paths: {}, fetched: [] }

            if (resolveOpts.frozen) {
                // --frozen asserts the machine is already provisioned. It
                // must not become the thing that provisions it, or the check
                // could never fail.
                const absent = parsed.filter(m => !m.sha256 || !store.has(m.sha256, m.file.split("/").pop()!))
                if (absent.length > 0) {
                    throw err("MODEL_NOT_CACHED", {
                        detail:
                            `${absent.map(m => m.key).join(", ")} not in the model cache — `
                            + `run \`axon prepare\` without --frozen to fetch`,
                        context: { keys: absent.map(m => m.key) },
                    })
                }
            }

            const paths: Record<string, string> = {}
            const fetched: string[] = []

            for (const model of parsed) {
                if (model.set) {
                    const stored = await fetcher.manifest({
                        repo: { host: model.host, repo: model.repo, rev: model.rev, key: model.key },
                        files: [], primary: "", options: resolveOpts, traits: model.traits,
                    })
                    paths[model.key] = stored.path
                    if (stored.path) fetched.push(model.key)
                    continue
                }

                const stored = await fetcher.file(model, {
                    onDownload: m => {
                        fetched.push(m.key)
                        resolveOpts.onDownload?.(m)
                    },
                    // Threaded rather than dropped: the fetcher reports bytes as
                    // they land, and a caller that cannot see them can only show
                    // a spinner for a five-gigabyte transfer.
                    ...(resolveOpts.signal ? { signal: resolveOpts.signal } : {}),
                ...(resolveOpts.onProgress ? { onProgress: resolveOpts.onProgress } : {}),
                    ...(model.traits ? { traits: model.traits } : {}),

                })
                paths[model.key] = stored.path
            }

            return { paths, fetched }
        },
    }
}

export type ModelsT = ReturnType<typeof Models>
