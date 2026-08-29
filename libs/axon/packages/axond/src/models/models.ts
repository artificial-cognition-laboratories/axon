import { statSync } from "node:fs"
import { err } from "@arcforge/err"
import { Models as PlatformModels, ModelStore } from "@arcforge/platform/build/project"
import { Adapters, type AdaptersT, type LoadedWeight } from "./adapter"
import { Catalog, files, preferred, repo, type CatalogT } from "./catalog"
import { parseSpecifier } from "./specifier"
import { OnnxAdapter } from "./onnx"
import type { EngineType } from "@arcforge/types"
import type { ModelRecord, ModelRuntime, ModelsState } from "./types"
import type { MachineT } from "../machine/index"

export type ModelsOpts = {
    /**
     * Admission and residency — the machine's, not this domain's.
     *
     * A load is a claim on video memory, and the thing that owns the GPU
     * decides whether it fits. Models owning its own accounting would be the
     * second answer to "how full is the card", which is precisely the failure
     * the daemon exists to prevent.
     */
    machine: MachineT
    /** Override the weight cache. Tests point this at a scratch dir. */
    root?: string
    /** Which runtimes this daemon can execute with. Injected so a test can supply a fake. */
    adapters?: AdaptersT
    /** What can be downloaded. Injected so a test never depends on Hugging Face. */
    catalog?: CatalogT
}

/**
 * Models — every weight this machine has, and which are loaded.
 *
 * ── The three states, kept apart ────────────────────────────────────────────
 *
 *   catalogued  it exists somewhere; nothing local
 *   cached      the bytes are on this disk, costing disk alone
 *   resident    it is loaded, costing memory, and something holds it
 *
 * Collapsing the last two would make "unload" and "delete" one gesture. They
 * are not: unloading frees the GPU and keeps the download, deleting frees the
 * disk and costs a re-fetch.
 *
 * ── Acquisition is the platform's, execution is the adapters' ───────────────
 *
 * `ModelStore` already fetches from Hugging Face, verifies by hash and caches
 * content-addressed machine-wide — ten agents share one copy of a 150MB
 * weight. None of that is re-implemented here; this owns what the platform
 * deliberately does not, which is running the bytes.
 *
 * The store knows nothing about ML and should not: a weight is a file with a
 * hash. The adapter layer is where "what can execute this" lives, and it is a
 * list of runtimes rather than a switch — see adapter.ts.
 */
export function Models(opts: ModelsOpts) {
    const store = ModelStore(opts.root !== undefined ? { root: opts.root } : {})
    // ONNX first and alone: it covers transform and stream — ASR, VAD,
    // embeddings, vision — with one dependency. Generation stays with Ollama
    // and LM Studio, which are already providers.
    const adapters = opts.adapters ?? Adapters([OnnxAdapter()])
    const catalog = opts.catalog ?? Catalog()
    // The platform's fetcher, pointed at the same store this reads. Acquisition
    // is its concern — hash verification, atomic writes, content addressing —
    // and re-implementing any of it here would be a second answer to "are
    // these the right bytes".
    const platform = PlatformModels({ store: store })

    /** What is loaded right now, by specifier. */
    const resident = new Map<string, { weight: LoadedWeight; record: ModelRecord; hold: string }>()
    /** What is on disk, as of the last refresh. See `state()` for why it is not read per call. */
    let cached: ModelRecord[] = []

    /**
     * Stamp a catalogue row with what this machine already knows about it.
     *
     * A listing says nothing about local state, and a row that offered
     * "Download" for a weight already on disk would be asking for work that
     * is done. Matched on the specifier PREFIX because a cached id carries the
     * pin and inner path (`…@main/onnx/model.onnx`) while a listing names the
     * repository alone.
     */
    function mark(model: ModelRecord): ModelRecord {
        // Matched on the REPOSITORY, not the raw id. A cached specifier
        // carries the pin and the inner path — `…@main/onnx/model.onnx` —
        // while a listing names the repository alone, so a prefix comparison
        // of the two misses and a downloaded model reads as available.
        const wanted = parseSpecifier(model.id)
        const local = cached.find(entry => {
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
            resident: resident.has(local.id),
        }
    }

    /**
     * Re-read what is on disk.
     *
     * The store's index is the source: it already maps every fetched
     * specifier to its content-addressed file, so this enumerates rather
     * than walking directories and guessing which files are models.
     *
     * A named closure rather than a method, because the handle is invoked
     * DETACHED: Dispatch path-walks to a verb and calls it, so `this` inside
     * one is undefined and a sibling reached through it throws. Every verb
     * another verb calls lives out here for that reason.
     */
    async function refresh(): Promise<ModelRecord[]> {
        const entries = await store.list()
        cached = entries.map(entry => record({
            model: entry.specifier,
            bytes: entry.bytes,
            path: entry.path,
            // Whether anything can RUN it, asked of the adapters rather
            // than assumed. A weight this machine fetched and cannot
            // execute is a coherent state, and the row should say so.
            runtime: adapters.for(entry.path)?.runtime ?? null,
            cached: true,
            resident: resident.has(entry.specifier),
        }))
        return cached
    }

    /** Release one resident weight and the hold it took. See `refresh` on why this is a closure. */
    async function unload(model: string): Promise<boolean> {
        const entry = resident.get(model)
        if (!entry) return false

        resident.delete(model)
        opts.machine.residency.release(entry.hold)
        await entry.weight.unload()
        return true
    }

    return {
        adapters: adapters,
        catalog: catalog,

        /**
         * Search what can be downloaded.
         *
         * Cache-first with ONE exception: a query nothing is cached for awaits
         * the network rather than returning empty. That difference is the
         * whole feel of the panel — a warm query is instant off disk, and a
         * cold one shows results rather than an empty list that fills in a
         * second later. An empty state a person reads as "no matches" and then
         * watches change is worse than a brief wait.
         *
         * Entries already on this machine are marked, so a row offers "Load"
         * rather than "Download" without a second lookup.
         */
        async search(query: string): Promise<ModelRecord[]> {
            const hit = catalog.cached(query)
            if (hit.length > 0) {
                // Warm: answer now, refresh behind it.
                void catalog.refresh(query)
                return hit.map(mark)
            }
            return (await catalog.refresh(query))?.map(mark) ?? []
        },

        /**
         * One repository in full — metadata, weight files, and its card.
         *
         * Marked like a search row, so a detail page knows whether this
         * machine already holds it without a second lookup.
         */
        async at(specifier: string): Promise<ModelRecord & { weights: string[]; readme: string | null }> {
            const detail = await repo(specifier)
            const marked = mark(record({
                model: detail.id,
                bytes: null,
                runtime: null,
                type: detail.type,
                downloads: detail.downloads,
                cached: false,
                resident: false,
            }))
            return { ...marked, weights: detail.weights, readme: detail.readme }
        },

        /** Fetch one query, bypassing the cache. What a "check again" gesture calls. */
        async searchFresh(query: string): Promise<ModelRecord[]> {
            return (await catalog.refresh(query))?.map(mark) ?? catalog.cached(query).map(mark)
        },

        /**
         * Everything the domain reports in one read.
         *
         * Synchronous, so a surface can render without awaiting — which means
         * `cached` reads the last enumeration rather than the disk. `refresh()`
         * is what re-reads it; the daemon does that on start and after every
         * fetch, so the answer is current without every render paying a
         * directory walk.
         */
        state(): ModelsState {
            return {
                cached: cached,
                resident: [...resident.values()].map(entry => entry.record),
                root: store.root,
            }
        },

        refresh: refresh,

        /**
         * Fetch a weight to this machine's cache.
         *
         * Acquisition is the PLATFORM'S: it verifies by hash, writes
         * atomically through a temp path, and caches content-addressed so ten
         * agents share one copy. None of that is re-implemented — this domain
         * owns running the bytes, not getting them.
         *
         * `file` names the weight inside the repository. A repository is not a
         * model: `onnx-community/silero-vad` ships eight ONNX files, and
         * Whisper ships an encoder AND a decoder that are both required. When
         * it is omitted the conventional `onnx/model.onnx` is used, and a
         * repository with no single weight is refused rather than half-fetched
         * — see `preferred`.
         */
        async fetch(input: string | { specifier: string; file?: string }): Promise<ModelRecord> {
            // One argument crosses the wire (see Dispatch), so a caller with
            // two passes an object. A bare string is the ergonomic form for an
            // in-process caller and means the same thing.
            const { specifier, file } = typeof input === "string" ? { specifier: input, file: undefined } : input
            const existing = await store.resolved(specifier)
            if (existing) {
                await refresh()
                return record({
                    model: specifier,
                    bytes: existing.bytes,
                    path: existing.path,
                    runtime: adapters.for(existing.path)?.runtime ?? null,
                    cached: true,
                    resident: resident.has(specifier),
                })
            }

            const target = file ?? preferred(await files(specifier))
            if (!target) {
                throw err("MODEL_NO_SINGLE_WEIGHT", {
                    detail: `${specifier} publishes no single weight — name the file to fetch`,
                    context: { specifier: specifier },
                })
            }

            // `hf:owner/repo/path/inside.onnx` — the shape the platform's
            // parser takes. Built here because a catalogue entry names the
            // repository and the file separately.
            const ref = `${specifier}/${target}`
            const { paths } = await platform.resolve({ weight: ref })
            const path = paths.weight!

            /**
             * The size is read from the FILE, not from the store's index.
             *
             * The index is keyed by the NORMALISED specifier — `…@main/…` —
             * which the parser adds while resolving. Looking it up by the ref
             * as written misses, and a miss reads as null: the record reported
             * a 90MB weight as unknown-sized, which renders as `0.0MB`.
             *
             * The file is on disk and its size is not in question, so this
             * asks the filesystem rather than an index it would have to
             * reconstruct the key for.
             */
            await refresh()
            return record({
                model: ref,
                bytes: statSync(path).size,
                path: path,
                runtime: adapters.for(path)?.runtime ?? null,
                cached: true,
                resident: resident.has(ref),
            })
        },

        /**
         * Load a weight into memory and take a hold on it.
         *
         * ADMISSION FIRST, deliberately. The machine decides whether it fits,
         * and it measures against the whole card rather than Axon's share —
         * something else may already have taken the memory. Loading first and
         * accounting afterwards is how two agents both get the same six
         * gigabytes.
         *
         * The hold is taken AFTER the load succeeds: a hold for a weight that
         * failed to load would shrink the machine's apparent capacity for as
         * long as the daemon lived, and nothing would clear it.
         */
        async load(input: { path: string; model: string; agent: string; role: string }): Promise<ModelRecord> {
            const existing = resident.get(input.model)
            if (existing) return existing.record

            const { runtime, weight } = await adapters.load(input.path)

            const verdict = opts.machine.admit(weight.bytes)
            if (!verdict.ok) {
                // Unloaded again rather than kept: refusing after paying the
                // memory would be the worst of both — the load happened, the
                // caller was told no, and the card is full anyway.
                await weight.unload()
                throw err("MODEL_WILL_NOT_FIT", {
                    detail: `${input.model} needs ${weight.bytes} bytes and ${verdict.available} are available`,
                    context: {
                        model: input.model,
                        wanted: verdict.wanted,
                        available: verdict.available,
                        holders: verdict.holders.map(hold => `${hold.agent}:${hold.model}`),
                    },
                })
            }

            const hold = opts.machine.residency.take({
                agent: input.agent,
                role: input.role,
                model: input.model,
                bytes: weight.bytes,
            })

            const loaded = record({
                model: input.model,
                bytes: weight.bytes,
                path: input.path,
                runtime: runtime,
                cached: true,
                resident: true,
            })

            resident.set(input.model, { weight: weight, record: loaded, hold: hold.id })
            return loaded
        },

        /**
         * Unload a weight and release its hold.
         *
         * False when it was not loaded — a real answer, not a failure. The
         * hold goes with it: a released weight whose record survived would
         * make the machine look fuller than it is until something reaped it.
         */
        unload: unload,

        /**
         * Run one inference against a loaded weight.
         *
         * Refuses rather than loading on demand: an implicit load is a memory
         * claim a caller did not make, and admission is a decision that should
         * be visible at the point it is taken.
         */
        async run(model: string, input: unknown): Promise<unknown> {
            const entry = resident.get(model)
            if (!entry) {
                throw err("MODEL_NOT_RESIDENT", {
                    detail: `${model} is not loaded — load it before running inference against it`,
                    context: { model: model },
                })
            }
            return entry.weight.run(input)
        },

        /** Unload everything. Called when the daemon stops serving. */
        async dispose(): Promise<void> {
            await Promise.all([...resident.keys()].map(model => unload(model)))
        },
    }
}

export type ModelsT = ReturnType<typeof Models>

/**
 * One model record, from what is known about it.
 *
 * Below the factory because it serves it, and shared by every path that
 * produces one — a second construction is where the next field gets added to
 * one and forgotten in the other.
 *
 * `type`, `in` and `out` are the honest defaults: a cognet declares what a
 * ROLE needs, and a weight sitting on disk says nothing about what it is for.
 * They become real when a manifest carries them, and inventing them here would
 * be a claim the file does not make.
 */
function record(input: {
    model: string
    bytes: number | null
    runtime: ModelRuntime | null
    cached: boolean
    resident: boolean
    path?: string | null
    /** What the source reports, when it reports one — see the defaults below. */
    type?: EngineType
    downloads?: number | null
}): ModelRecord {
    const parsed = parseSpecifier(input.model)

    return {
        id: parsed.id,
        name: parsed.name,
        owner: parsed.owner,
        source: parsed.scheme === "ollama" ? "ollama" : "huggingface",
        runtime: input.runtime,
        type: input.type ?? "transform",
        in: [],
        out: [],
        bytes: input.bytes,
        path: input.path ?? null,
        cached: input.cached,
        resident: input.resident,
        description: null,
        downloads: input.downloads ?? null,
    }
}
