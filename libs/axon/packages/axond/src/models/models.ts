import { statSync } from "node:fs"
import { err } from "@arcforge/err"
import { Models as PlatformModels, ModelStore } from "@arcforge/platform/build/project"
import { Adapters, type AdaptersT, type LoadedWeight } from "./adapter"
import { Catalog, files, plan, preferred, repo, type CatalogT } from "./catalog"
import { Downloads, alreadyRunning, type Download } from "./downloads"
import { parseSpecifier } from "./specifier"
import { LlamaAdapter } from "./llama"
import { OnnxAdapter } from "./onnx"
import { TransformersAdapter } from "./transformers"
import type { EngineType, Modality } from "@arcforge/types"
import { estimateBytes, fitFor, order, type ModelSort } from "./fit"
import type { ModelCapability, ModelRecord, ModelRuntime, ModelsState } from "./types"
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
    /**
     * Whether `run` may load a weight that is not resident. Defaults to true.
     *
     * A thunk, not a value: it is a stored preference that can change while
     * the daemon runs, and a boolean captured at construction would hold
     * whatever was true at boot for the life of the process.
     */
    autoload?: () => boolean
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
/** Everything a caller can ask of a search. */
export type SearchInput = {
    query: string
    capability?: ModelCapability
    sort?: ModelSort
    /** Drop weights that certainly will not run here. Unknown sizes survive. */
    fitsOnly?: boolean
}

function normalise(input: string | SearchInput): Required<Omit<SearchInput, "capability">> & { capability?: ModelCapability } {
    const given = typeof input === "string" ? { query: input } : input
    return {
        query: given.query,
        ...(given.capability !== undefined ? { capability: given.capability } : {}),
        sort: given.sort ?? "relevance",
        fitsOnly: given.fitsOnly ?? false,
    }
}

/**
 * The holder recorded for a weight a person loaded by hand.
 *
 * A residency hold always names who holds it. A manual load has a real
 * holder — it just is not an agent — so it says so rather than leaving the
 * field blank and making every reader of `holds` handle an absent owner.
 */
const PERSON = "you"

export function Models(opts: ModelsOpts) {
    const store = ModelStore(opts.root !== undefined ? { root: opts.root } : {})
    // ONNX first and alone: it covers transform and stream — ASR, VAD,
    // embeddings, vision — with one dependency. Generation stays with Ollama
    // and LM Studio, which are already providers.
    // ONNX first: its claim is a cheap suffix test, while llama.cpp opens the
    // file to read its magic bytes. Claim order is try order, so the cheaper
    // question is asked first.
    /*
     * Claim order is the tie-break policy — see Adapters.
     *
     * Transformers first because it is the only one that claims a DIRECTORY,
     * and it declines everything else immediately; the two file adapters below
     * never see a path it took. Putting it last would work identically today
     * and stop working the moment a file adapter learns to claim a directory,
     * so the specific runtime goes first while the rule is still cheap to keep.
     */
    const adapters = opts.adapters ?? Adapters([TransformersAdapter(), OnnxAdapter(), LlamaAdapter()])
    const catalog = opts.catalog ?? Catalog()
    // The platform's fetcher, pointed at the same store this reads. Acquisition
    // is its concern — hash verification, atomic writes, content addressing —
    // and re-implementing any of it here would be a second answer to "are
    // these the right bytes".
    const platform = PlatformModels({ store: store })

    /**
     * Transfers in flight. Owned here because the daemon outlives every
     * surface that starts one — see Downloads.
     */
    const downloads = Downloads()

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
            //
            // Routed on the path that will actually be LOADED. For a set
            // that is the directory, which the transformers adapter claims and
            // the file adapters decline — so the row names the runtime that
            // will run it rather than the one that could open its primary file
            // in isolation. Those differ: a Whisper export's decoder is a
            // valid ONNX graph and a useless half of a model.
            runtime: adapters.for(entry.path)?.runtime ?? null,
            /*
             * What the registry said this was, kept by the store at fetch
             * time. Absent for anything downloaded before that was recorded,
             * and `record()` still falls back to "other" — a weight whose task
             * nobody wrote down is genuinely unknown, and guessing from a
             * filename would be the invention the old default avoided.
             */
            ...(entry.traits?.capability
                ? { capability: entry.traits.capability as ModelCapability }
                : {}),
            ...(entry.traits?.type ? { type: entry.traits.type as EngineType } : {}),
            ...(entry.traits?.in ? { in: entry.traits.in as Modality[] } : {}),
            ...(entry.traits?.out ? { out: entry.traits.out as Modality[] } : {}),
            cached: true,
            resident: resident.has(entry.specifier),
        }))
        return cached
    }

    /** Load a weight and take a hold on it. See `refresh` on why this is a closure, not a method. */
    /**
     * `hf:owner/repo@rev` split into the parts a set fetch addresses.
     *
     * The single-file path builds `hf:owner/repo/file` and lets the platform's
     * parser split it; a set has no file to append, so the pieces are taken
     * apart here rather than round-tripped through a string that would have to
     * encode "no file" somehow.
     */
    function repoOf(specifier: string): { host: "hf"; repo: string; rev: string; key: string } {
        const body = specifier.replace(/^hf:/, "")
        const [name, rev] = body.split("@")
        return { host: "hf", repo: name!, rev: rev ?? "main", key: name! }
    }

    /**
     * Decide how a repository should be fetched: as one weight, or as a set.
     *
     * The runtime decides, not the person. llama.cpp takes a single `.gguf`
     * and does its own tokenising; transformers.js takes a DIRECTORY because
     * an ONNX graph cannot tokenise anything and needs the configuration that
     * ships beside it. So the question "one file or many" is answered by
     * which adapter will run this, and a caller naming a specific file is
     * saying "this one weight", which is always the single-file path.
     *
     * Returns null when the repository has no ONNX in it — GGUF and the rest
     * fall through to `preferred()` exactly as before.
     */
    async function planFor(specifier: string, file?: string): Promise<{ files: string[]; primary: string } | null> {
        if (file) return null
        const listing = await files(specifier)
        const chosen = preferred(listing)
        // A repository whose nominated weight is a GGUF is a single file even
        // when it also ships an ONNX export — the adapter that will run it
        // wants one path.
        if (chosen && !chosen.toLowerCase().endsWith(".onnx")) return null
        return plan(listing)
    }

    /**
     * Write down what a cached weight is, from the registry's own description.
     *
     * Best effort by design: the bytes are on this machine either way, and a
     * registry that is unreachable or a repository that publishes no task must
     * not turn a completed download into a failure. An undescribed weight
     * reads as "other", which is what it read as before any of this existed.
     *
     * A named closure rather than a method — the handle is invoked DETACHED,
     * so `this` inside a verb is undefined.
     */
    async function describe(repository: string): Promise<void> {
        try {
            const detail = await catalog.detail(repository)
            /*
             * Keyed by what the STORE calls it, not by what was asked for.
             *
             * The index key is the normalised specifier — `hf:owner/repo@main/
             * file.onnx` — which the parser produces while resolving, and a
             * repository specifier does not match it. Writing under the name
             * the caller used put traits on an entry `list()` never returns,
             * which looked exactly like nothing being written at all.
             *
             * So the keys are read back off the enumeration, and every weight
             * this repository resolved to is described: a repo can publish an
             * encoder and a decoder, and both are the same kind of thing.
             */
            const entries = await store.list()
            /*
             * Direction is kept alongside the capability, not derived later.
             *
             * `capability: "speech"` covers recognition AND synthesis, so a
             * cached Whisper and a cached Kokoro were indistinguishable — the
             * dictation surface had no way to avoid offering a model that
             * cannot transcribe. `in`/`out` are the kernel's own vocabulary for
             * the difference, and fetch time is the only moment the task tag is
             * in hand: nothing on disk records it.
             */
            const traits = {
                capability: detail.capability,
                type: detail.type,
                in: detail.in,
                out: detail.out,
            }
            await Promise.all(entries
                .filter(entry => entry.specifier.startsWith(repository))
                .map(entry => store.describe(entry.specifier, traits)))
        } catch {
            // Deliberately swallowed, and the only place in this file that
            // does: this is metadata about a download that already succeeded.
            // Rethrowing would fail the fetch over a label.
        }
    }

    /**
     * Find a cached weight and load it, for a person.
     *
     * Shared by `pin` and by `run`'s autoload, so there is one answer to
     * "where are the bytes, and is this even here" — two copies would drift
     * the moment one of them learned about a new store layout.
     *
     * A named closure rather than a method, because the handle is invoked
     * DETACHED: Dispatch path-walks to a verb and calls it, so `this` inside
     * would be undefined.
     */
    async function admit(model: string, role: string): Promise<ModelRecord> {
        // Re-enumerates before giving up. `cached` is a cache of the disk
        // populated by `refresh()`, and a process that has not run one yet
        // would report every weight on the machine as absent — which is
        // exactly what a one-shot CLI invocation is.
        let entry = cached.find(item => item.id === model)
        if (!entry) entry = (await refresh()).find(item => item.id === model)
        // No path means the enumeration could not place the bytes. That is not
        // the same as absent, and loading a guess would be worse than saying so.
        if (!entry || !entry.path) {
            throw err("MODEL_NOT_CACHED", {
                detail: `${model} is not on this machine — download it before loading it`,
                context: { model: model },
            })
        }
        /*
         * A SET cannot be loaded yet, and says so rather than half-loading.
         *
         * `entry.path` is a directory for a set, and every adapter here claims
         * FILES — so routing on the primary weight would hand llama.cpp or the
         * raw ONNX session one member of a model that has several. Whisper's
         * decoder without its encoder loads perfectly and then produces
         * nonsense, which is the exact failure this codebase refuses to ship:
         * a broken state that reports success.
         *
         * The runtime that takes a directory is the transformers.js adapter,
         * and it is not written. Until it is, downloading a set works, listing
         * it works, and loading it is refused with the reason.
         */
        if (!adapters.for(entry.path)) {
            const stored = await store.resolved(model)
            if (stored?.primary) {
                throw err("MODEL_RUNTIME_MISSING", {
                    detail: `${model} is a model repository — running one needs `
                        + `@huggingface/transformers, which is not installed`,
                    context: { model: model, files: entry.path },
                })
            }
        }

        return await loadWeight({ path: entry.path, model: model, agent: PERSON, role: role })
    }

    async function loadWeight(input: { path: string; model: string; agent: string; role: string }): Promise<ModelRecord> {
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
        async search(input: string | SearchInput): Promise<ModelRecord[]> {
            // One argument crosses the wire (see Dispatch), so a caller with
            // several passes an object. A bare string is the ergonomic form and
            // means the same thing unscoped.
            const { query, capability, sort, fitsOnly } = normalise(input)

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
            const hit = catalog.cached(query, capability, fitsOnly)
            if (hit.length > 0) {
                // Warm: answer now, refresh behind it.
                void catalog.refresh(query, capability, fitsOnly)
                return judge(hit.map(mark), sort, fitsOnly)
            }
            const fresh = (await catalog.refresh(query, capability, fitsOnly))?.map(mark) ?? []
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
            const { query, capability, sort, fitsOnly } = normalise(input)
            const models = (await catalog.more(query, capability, fitsOnly))
                ?? catalog.cached(query, capability, fitsOnly)
            return judge(models.map(mark), sort, fitsOnly)
        },

        /** Whether another page exists for this search. */
        hasMore(input: string | SearchInput): boolean {
            const { query, capability, fitsOnly } = normalise(input)
            return catalog.hasMore(query, capability, fitsOnly)
        },

        /**
         * One repository in full — metadata, weight files, and its card.
         *
         * Marked like a search row, so a detail page knows whether this
         * machine already holds it without a second lookup.
         */
        async at(specifier: string): Promise<ModelRecord & {
            weights: string[]
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
                const known = cached.find(entry => entry.id === specifier)
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
            const detail = await catalog.detail(specifier)
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
                downloads: downloads.list(),
                /*
                 * Residency is read LIVE, not taken from the cached row.
                 *
                 * `cached` is rebuilt by `refresh()`, which walks the disk; a
                 * weight loaded since the last walk kept `resident: false` on
                 * its row while appearing in `resident` and in the holds. Two
                 * sources for one fact, and a surface reading the row showed
                 * "on disk" for a model it had just listed as loaded.
                 *
                 * The map is the authority — it IS the set of loaded weights —
                 * so the row is corrected on the way out rather than the whole
                 * enumeration being redone on every read.
                 */
                cached: cached.map(record => record.resident === resident.has(record.id)
                    ? record
                    : { ...record, resident: resident.has(record.id) }),
                resident: [...resident.values()].map(entry => entry.record),
                root: store.root,
            }
        },

        refresh: refresh,

        /** Generation-capable local weights Axond can actually execute. */
        async local(): Promise<import("@arcforge/types").EngineCapability[]> {
            const records = cached.length > 0 ? cached : await refresh()
            return records
                // A GGUF claimed by llama.cpp is a text-generation weight. Its
                // registry task is often absent, so requiring a "chat" tag
                // would hide every manually-cached local model from the one
                // route meant to run it.
                .filter(record => record.runtime === "llama.cpp" && record.path !== null)
                .map(record => ({
                    id: record.id,
                    provider: "local",
                    name: record.name,
                    type: "generate" as const,
                    in: ["text" as const],
                    out: ["text" as const],
                    local: true,
                    ...(record.bytes !== null ? { bytes: record.bytes } : {}),
                }))
        },

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
                await describe(specifier)
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

            /*
             * A set, when a runtime needs one. See `planFor`.
             *
             * `MODEL_NO_SINGLE_WEIGHT` used to be thrown here for exactly the
             * repositories this handles — an ONNX export publishing an
             * encoder and a decoder had "no single weight" and could not be
             * fetched at all. It survives below for the case it was really
             * about: several unrelated candidates and no way to choose.
             */
            const set = await planFor(specifier, file)
            if (set) {
                const parsed = repoOf(specifier)
                const stored = await platform.resolveSet(parsed, set.files, set.primary)
                await describe(specifier)
                await refresh()
                return record({
                    model: `${parsed.host}:${parsed.repo}@${parsed.rev}`,
                    bytes: stored.bytes,
                    path: stored.path,
                    // Routed on the PRIMARY weight, not the directory: adapters
                    // claim files, and a directory claims nothing.
                    runtime: adapters.for(stored.primary ?? stored.path)?.runtime ?? null,
                    cached: true,
                    resident: resident.has(`${parsed.host}:${parsed.repo}@${parsed.rev}`),
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
            // What it IS, recorded beside where it landed. The registry knows
            // and this is the only moment we are holding both — enumerating
            // the cache later can only see a filename.
            await describe(specifier)
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
         * Delete a cached weight from this machine.
         *
         * Unloads first, always. Removing bytes a process has mapped is how a
         * delete becomes a crash rather than a free — and the hold would
         * outlive the file, shrinking the machine's apparent capacity for a
         * weight that no longer exists.
         *
         * The store decides whether the bytes actually go: another specifier
         * may address the same hash, and content-addressing is what lets ten
         * agents share one copy. This domain owns running weights, not
         * deciding when bytes are unreferenced.
         *
         * Takes the record id from `state().cached`, which IS the store's
         * index key — no second addressing scheme to keep in step.
         */
        async remove(model: string): Promise<boolean> {
            await unload(model)
            const removed = await store.remove(model)
            await refresh()
            return removed
        },

        /** Every transfer this daemon is running, newest first. */
        downloads(): Download[] {
            return downloads.list()
        },

        /**
         * Begin a fetch and return its id, without waiting for it.
         *
         * The non-blocking twin of `fetch`. `fetch` stays as it is because
         * `prepare` and an agent's boot genuinely need to wait — a brain whose
         * weights are missing is broken, not slow. A person clicking Download
         * does not: they want the panel to keep working, and the transfer to
         * survive them closing it.
         */
        download(input: string | { specifier: string; file?: string }): { id: string } {
            const { specifier, file } = typeof input === "string" ? { specifier: input, file: undefined } : input

            const running = downloads.inFlight(specifier)
            if (running) alreadyRunning(specifier)

            const id = downloads.start(specifier, async (report: (p: { file?: string; received: number; total: number | null }) => void) => {
                const set = await planFor(specifier, file)
                if (set) {
                    /*
                     * Progress across a SET, carried rather than restarted.
                     *
                     * The fetcher reports bytes per file and knows nothing
                     * about the others, so a bar bound straight to it would
                     * run to full and snap back to zero once per member —
                     * forty times for a Whisper export. Completed files are
                     * accumulated here and the running one added on top, so
                     * the number only ever goes up.
                     *
                     * `total` stays null until the last file: the sizes are
                     * not known before each transfer starts, and a total that
                     * grows would make the bar travel backwards. A row with no
                     * total renders as indeterminate, which is the truth.
                     */
                    let done = 0
                    let current = 0
                    let at = 0
                    report({ file: `${set.files.length} files`, received: 0, total: null })
                    await platform.resolveSet(repoOf(specifier), set.files, set.primary, {
                        onDownload: model => {
                            done += current
                            current = 0
                            at += 1
                            report({ file: `${model.file} (${at}/${set.files.length})`, received: done, total: null })
                        },
                        onProgress: progress => {
                            current = progress.received
                            report({ received: done + current, total: null })
                        },
                    })
                    await describe(specifier)
                    await refresh()
                    return
                }

                const target = file ?? preferred(await files(specifier))
                if (!target) {
                    throw err("MODEL_NO_SINGLE_WEIGHT", {
                        detail: `${specifier} publishes no single weight — name the file to fetch`,
                        context: { specifier: specifier },
                    })
                }
                report({ file: target, received: 0, total: null })

                const ref = `${specifier}/${target}`
                await platform.resolve({ weight: ref }, {
                    onProgress: progress => report({ received: progress.received, total: progress.total }),
                })

                // The store is the source of truth for what is cached, and it
                // has just changed — so the next `state()` reports the weight
                // rather than the caller having to ask for a refresh.
                await refresh()
            })

            return { id: id }
        },

        /** Stop reporting a transfer. See Downloads.cancel on what that does and does not promise. */
        cancelDownload(id: string): boolean {
            return downloads.cancel(id)
        },

        /** Forget a finished transfer now rather than letting it age out. */
        dismissDownload(id: string): boolean {
            return downloads.dismiss(id)
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
        load: loadWeight,

        /**
         * Load a weight because a PERSON asked, not because an agent needs it.
         *
         * The same admission and the same hold — the only difference is who
         * holds it. `load` demands an agent because a weight in memory with no
         * holder is how video memory leaks; a manual load has a real holder,
         * it just is not an agent, so it names itself as one rather than
         * punching a hole through residency for an optional field.
         *
         * `unload` releases it like any other. Takes the record id from
         * `state().cached`, which carries the path — so a caller never has to
         * know where the store put the bytes.
         */
        async pin(model: string): Promise<ModelRecord> {
            return await admit(model, "manual")
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
         * Loads first only when `autoload` is on, which it is by default.
         *
         * The original rule was a flat refusal, because an implicit load is a
         * memory claim the caller did not make. That reasoning survives — what
         * changed is WHERE the claim is made. A declared preference is a claim
         * made once, visibly, by the person who owns the machine; what was
         * worth refusing is an admission nobody can see, not admission itself.
         * Turn the flag off and the old refusal returns verbatim.
         *
         * The budget check is untouched either way: autoload decides whether
         * to ASK for room, never whether there is any.
         *
         * ONE object in, because this crosses the socket. Dispatch carries a
         * single argument, so a second positional parameter would arrive
         * `undefined` — the verb would work in-process and silently run
         * against nothing over the wire.
         */
        async run(input: { model: string; input: unknown }): Promise<unknown> {
            let entry = resident.get(input.model)
            if (!entry) {
                if (!(opts.autoload?.() ?? true)) {
                    throw err("MODEL_NOT_RESIDENT", {
                        detail: `${input.model} is not loaded — load it before running inference against it`,
                        context: { model: input.model },
                    })
                }
                await admit(input.model, "auto")
                entry = resident.get(input.model)
                // Admission returning without a resident entry would mean the
                // load reported success and left nothing behind — a fault in
                // this file, not a user error, and it must not read as "your
                // model is missing".
                if (!entry) {
                    throw err("MODEL_LOAD_FAILED", {
                        detail: `${input.model} loaded but is not resident — the hold was not recorded`,
                        context: { model: input.model },
                    })
                }
            }

            /*
             * Routed by the weight's own handle shape.
             *
             * A generative model handed a string gets `generate`, which is the
             * verb that knows a prompt is a prompt. Everything else goes to
             * `run`, the raw door — which is what an audio path, a tensor bag
             * or an embedding request wants, and what the adapters implement
             * identically to `transform`.
             *
             * Not a switch on CAPABILITY. That is the browsing vocabulary
             * ("speech", "chat") and this is the calling one; using one where
             * the other belongs is how a model that browses as speech ends up
             * being called as a chat model.
             */
            const weight = entry.weight
            if (weight.engine === "generate" && weight.generate && typeof input.input === "string") {
                return await weight.generate({ prompt: input.input })
            }
            return await weight.run(input.input)
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
    capability?: ModelCapability
    in?: Modality[]
    out?: Modality[]
    downloads?: number | null
    likes?: number | null
    updatedAt?: number | null
}): ModelRecord {
    const parsed = parseSpecifier(input.model)

    return {
        id: parsed.id,
        name: parsed.name,
        owner: parsed.owner,
        source: parsed.scheme === "ollama" ? "ollama" : "huggingface",
        // "other" for the same reason `type` defaults: a file on disk declares
        // no task, and filing it under a capability it may not have is worse
        // than admitting we do not know. A listing carries the real answer.
        capability: input.capability ?? "other",
        runtime: input.runtime,
        type: input.type ?? "transform",
        in: input.in ?? [],
        out: input.out ?? [],
        bytes: input.bytes,
        path: input.path ?? null,
        cached: input.cached,
        resident: input.resident,
        description: null,
        downloads: input.downloads ?? null,
        likes: input.likes ?? null,
        updatedAt: input.updatedAt ?? null,
        // Judged where the ceiling is known — see `judge` on the handle. A
        // record on its own describes a weight, not a machine.
        fit: "unknown",
        estimatedBytes: estimateBytes(parsed.name),
    }
}
