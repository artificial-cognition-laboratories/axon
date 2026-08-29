import { err } from "@arcforge/err"
import type { ModelRef } from "@arcforge/types"
import { fetchModel } from "./fetch"
import { parseModels, type ParsedModel } from "./specifier"
import { ModelStore, type ModelStoreT } from "./store"

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
         * Resolve every declared model to an absolute path, fetching what is
         * absent.
         *
         * Sequential rather than parallel: these are large files, and ten
         * concurrent 150MB downloads is a worse experience than ten in a row
         * on every connection that is not a datacentre.
         */
        async resolve(
            models: Record<string, ModelRef> | undefined,
            resolveOpts: { frozen?: boolean; onDownload?: (model: ParsedModel) => void } = {},
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
                const stored = await fetchModel(model, {
                    store,
                    onDownload: m => {
                        fetched.push(m.key)
                        resolveOpts.onDownload?.(m)
                    },
                })
                paths[model.key] = stored.path
            }

            return { paths, fetched }
        },
    }
}

export type ModelsT = ReturnType<typeof Models>
