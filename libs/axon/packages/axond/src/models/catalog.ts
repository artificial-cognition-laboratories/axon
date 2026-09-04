import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineType, Modality } from "@arcforge/types"
import { parseSpecifier } from "./specifier"
import { estimateBytes } from "./fit"
import type { ModelCapability, ModelRecord, ModelRuntime } from "./types"

type CatalogOpts = {
    /** Override the cache file. Tests point this at a scratch dir. */
    root?: string
    /** Injectable fetch, so a test never depends on Hugging Face being reachable. */
    fetch?: typeof fetch
}

/**
 * Catalog — what a person can download, searchable.
 *
 * ── Cached hard, on disk, with no TTL ───────────────────────────────────────
 *
 * The same posture `useRegistryCatalog` takes for Axon artifacts, and for the
 * same reasons — this is a VS Code panel, so the first open is the one a
 * person notices and an in-memory cache does nothing for it.
 *
 * So: results are written to `~/.axon/cache/models-catalog.json` and read back
 * synchronously on first use. A cached answer is served immediately and a
 * refresh runs behind it, swapping in when it lands.
 *
 * There is deliberately no TTL. A TTL only reintroduces the slow path it was
 * meant to remove, and the cost of being briefly stale is a recently-published
 * model missing from a list — far cheaper than a panel that waits on the
 * network every time it opens.
 *
 * ── Queries are cached individually ─────────────────────────────────────────
 *
 * Keyed by query rather than one blob, because the catalogue is not a small
 * set that can be fetched whole: Hugging Face publishes hundreds of thousands
 * of models. So a search anyone has run before is instant, and only a NEW
 * query pays the network. That is the shape the panel wants — people search
 * for the same handful of things.
 *
 * ── Failure keeps what is cached ────────────────────────────────────────────
 *
 * A failed refresh serves the previous answer rather than emptying the list:
 * offline degrades to "slightly stale", never to "nothing exists". Only a
 * failure with nothing cached shows empty, which is the honest answer then.
 */
/**
 * The shape of a cached row. Bump when `ModelRecord` gains or loses a field
 * this cache stores — an older file is then discarded rather than served with
 * holes in it.
 */
/*
 * 3 — `in`/`out` are now populated from the task tag (see modalitiesOf).
 *
 * Rows cached at shape 2 carry empty modality arrays, and empty means "nobody
 * wrote this down" to every reader. Dictation filters on direction, so a stale
 * cache would hide every Whisper on the machine and show no reason why.
 */
const SHAPE = 3

export function Catalog(opts: CatalogOpts = {}) {
    const path = opts.root ?? join(homedir(), ".axon", "cache", "models-catalog.json")
    const doFetch = opts.fetch ?? fetch

    /** query → results. Loaded once, written on every successful fetch. */
    let cache: Record<string, ModelRecord[]> = read()

    /**
     * specifier → full repository detail.
     *
     * Persisted beside the query cache, because a detail page is the slowest
     * thing here — the card alone is tens of kilobytes — and it was the one
     * thing refetched from the network on every visit. Held across restarts so
     * a model looked at yesterday opens instantly today.
     *
     * Unbounded for now, and it should not stay that way: a cap by total bytes,
     * evicting least-recently-read, is the obvious next move. Recorded in
     * debt.md rather than guessed at here.
     */
    let details: Record<string, RepoDetail> = readDetails()

    /**
     * Cursors for the next page, per cache key.
     *
     * PERSISTED, not session-lived. Every caller here is a separate process —
     * the CLI runs once per invocation and a desktop panel spawns one per
     * command — so a cursor held only in memory meant "load more" always
     * started from no cursor and re-served page one. Paging across processes
     * only works if the position outlives them.
     *
     * Declared HERE and not beside `refresh`, which sits after the returned
     * handle: a `const` past a `return` is never initialised, while the
     * function declarations around it hoist quite happily — so `refresh` threw
     * a ReferenceError its own catch swallowed into "the network failed".
     */
    let cursors: Record<string, (string | null)[]> = readCursors()

    function readCursors(): Record<string, (string | null)[]> {
        try {
            if (!existsSync(path)) return {}
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
                shape?: number
                cursors?: Record<string, (string | null)[]>
            }
            if (parsed.shape !== SHAPE) return {}
            return parsed.cursors ?? {}
        } catch {
            return {}
        }
    }

    function readDetails(): Record<string, RepoDetail> {
        try {
            if (!existsSync(path)) return {}
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
                shape?: number
                details?: Record<string, RepoDetail>
            }
            if (parsed.shape !== SHAPE) return {}
            return parsed.details ?? {}
        } catch {
            return {}
        }
    }

    function read(): Record<string, ModelRecord[]> {
        try {
            if (!existsSync(path)) return {}
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
                shape?: number
                queries?: Record<string, ModelRecord[]>
            }
            // A cache written before a field existed answers with rows missing
            // it, and nothing downstream can tell those from rows where the
            // field is genuinely absent — a capability filter silently matched
            // nothing because every cached row predated `capability`. Dropping
            // the file costs one refetch and is the only answer that cannot be
            // subtly wrong.
            if (parsed.shape !== SHAPE) return {}
            return parsed.queries ?? {}
        } catch {
            // A corrupt cache is an empty one. It costs a refetch and cannot
            // produce wrong rows, which is the right trade for a file nothing
            // but this writes.
            return {}
        }
    }

    function write(): void {
        try {
            mkdirSync(dirname(path), { recursive: true })
            writeFileSync(path, JSON.stringify({
                shape: SHAPE,
                fetchedAt: Date.now(),
                queries: cache,
                details: details,
                cursors: cursors,
            }), "utf-8")
        } catch {
            // A cache that cannot be written is a slow catalogue, not a broken
            // one — every query still works, it just pays the network again.
        }
    }

    return {
        /**
         * One repository in full, from disk when it is there.
         *
         * Cache-first with no revalidation: a model card changes rarely and a
         * stale one is a far smaller cost than refetching tens of kilobytes on
         * every visit. `refreshDetail` is the escape hatch when that matters.
         */
        async detail(specifier: string, doFetch: typeof fetch = fetch): Promise<RepoDetail> {
            const hit = details[specifier]
            if (hit) return hit
            return this.refreshDetail(specifier, doFetch)
        },

        /** Fetch one repository, bypassing the cache, and remember it. */
        async refreshDetail(specifier: string, doFetch: typeof fetch = fetch): Promise<RepoDetail> {
            const fresh = await repo(specifier, doFetch)
            details[specifier] = fresh
            write()
            return fresh
        },

        /** Where the cache lives. Diagnostics. */
        get path(): string {
            return path
        },

        /**
         * What is cached for this query, without touching the network.
         *
         * Synchronous, so a panel can render on its first frame. An empty
         * array means nothing is cached, not that nothing matches — the caller
         * follows with `search()` either way.
         */
        cached(query: string, capability?: ModelCapability, runnable = false): ModelRecord[] {
            return cache[key(query, capability, runnable)] ?? []
        },

        /**
         * Search, serving the cache first and refreshing behind it.
         *
         * Returns whatever is known NOW. `onUpdate` fires if the network
         * produced something different, so a caller renders instantly and
         * improves rather than waiting.
         */
        search(query: string, onUpdate?: (models: ModelRecord[]) => void): ModelRecord[] {
            const hit = cache[key(query)]

            void refresh(query, undefined).then(fresh => {
                if (!fresh) return
                // Fired only on a CHANGE: a caller re-rendering on every
                // identical answer would flash a list that did not move.
                if (JSON.stringify(fresh) !== JSON.stringify(hit)) onUpdate?.(fresh)
            })

            return hit ?? []
        },

        /** Fetch one query and cache it. Null when the network failed. */
        refresh,

        /** Fetch and append the next page. Null when there is none. */
        more,

        /** Whether another page exists. */
        hasMore,
    }

    async function refresh(query: string, capability?: ModelCapability, runnable = false): Promise<ModelRecord[] | null> {
        try {
            const found = await search(doFetch, query, capability, undefined, runnable)
            const k = key(query, capability, runnable)
            cursors[k] = found.cursors
            cache = { ...cache, [k]: found.models }
            write()
            return found.models
        } catch {
            // See the header: offline keeps what is cached.
            return null
        }
    }

    /**
     * The next page, appended to what is cached.
     *
     * Null when there is nothing further — which a caller shows as the end of
     * the list rather than as a failure. Deduplicated on append: paging by
     * cursor across several task tags can return a repository already seen from
     * another tag, and the same model twice is a bug a person can see.
     */
    async function more(query: string, capability?: ModelCapability, runnable = false): Promise<ModelRecord[] | null> {
        const k = key(query, capability, runnable)
        const carried = cursors[k]
        if (!carried || carried.every(cursor => cursor === null)) return null

        try {
            const found = await search(doFetch, query, capability, carried, runnable)
            cursors[k] = found.cursors

            const existing = cache[k] ?? []
            const seen = new Set(existing.map(model => model.id))
            const appended = [...existing, ...found.models.filter(model => !seen.has(model.id))]

            cache = { ...cache, [k]: appended }
            write()
            return appended
        } catch {
            return null
        }
    }

    /** Whether another page exists for this query. */
    function hasMore(query: string, capability?: ModelCapability, runnable = false): boolean {
        const carried = cursors[key(query, capability, runnable)]
        return !!carried && carried.some(cursor => cursor !== null)
    }
}

export type CatalogT = ReturnType<typeof Catalog>

/**
 * Normalised so `Whisper` and `whisper ` are one cache entry rather than three.
 *
 * The capability is part of the key because it is part of the QUESTION: the
 * registry is asked for speech models by tag, so the answer to "whisper" scoped
 * to speech is a different list from "whisper" unscoped, and one must not serve
 * the other from cache.
 */
function key(query: string, capability?: ModelCapability, runnable = false): string {
    const normalised = query.trim().toLowerCase()
    const scoped = capability ? `${capability}:${normalised}` : normalised
    // Part of the QUESTION, exactly as the capability is: a filtered search
    // asks the registry something different and its answer must not be served
    // to an unfiltered one.
    return runnable ? `runs:${scoped}` : scoped
}

/**
 * One Hugging Face search.
 *
 * `filter=onnx` rather than a text match on the name: it is the tag HF applies
 * to repositories that actually ship an ONNX export, so the results are models
 * this machine could RUN rather than every repository whose description
 * mentions the word. Searching without it returns PyTorch checkpoints the
 * daemon has no adapter for, which is a list of things that cannot be
 * downloaded usefully.
 */
async function search(
    doFetch: typeof fetch,
    query: string,
    capability?: ModelCapability,
    cursors?: (string | null)[],
    runnable = false,
): Promise<{ models: ModelRecord[]; cursors: (string | null)[] }> {
    const out: { cursors: (string | null)[] } = { cursors: [] }
    const [hugging, ollama] = await Promise.all([
        searchHuggingFace(doFetch, query, capability, cursors, out, runnable),
        // Its library is fetched whole on the first page; there is nothing to
        // page through, so a continuation asks only Hugging Face.
        cursors ? Promise.resolve([] as ModelRecord[]) : searchOllama(doFetch, query, capability),
    ])

    // Ollama first for a bare query, because its library is a curated handful
    // and Hugging Face's is a hundred rows deep — a short, good list buried
    // under a long one is a list nobody sees.
    return { models: [...ollama, ...hugging], cursors: out.cursors }
}

/**
 * One Hugging Face search.
 *
 * ── Why there is no format filter ───────────────────────────────────────────
 *
 * This asked for `filter=onnx`, reasoning that a list should only contain what
 * the machine can run. Two things made that wrong. `preferred()` now accepts
 * GGUF and safetensors, so llama.cpp-runnable models were being excluded by a
 * filter written when ONNX was the only adapter. And the row already reports
 * "no runtime here" honestly, so hiding a model is strictly less informative
 * than showing it and saying so.
 *
 * The listing carries format tags, so runnability is read from them rather than
 * guessed — no second request per row.
 */
async function searchHuggingFace(
    doFetch: typeof fetch,
    query: string,
    capability: ModelCapability | undefined,
    cursors: (string | null)[] | undefined,
    out: { cursors: (string | null)[] },
    runnable = false,
): Promise<ModelRecord[]> {
    /*
     * A capability is asked of the REGISTRY, not filtered out of a general
     * answer.
     *
     * Narrowing a page of a hundred general results locally meant "Speech"
     * showed however many of the top hundred downloads happened to be speech
     * models — a dozen, from a registry holding tens of thousands. Asking for
     * the tag returns the top hundred SPEECH models, which is the list someone
     * choosing that scope was actually after.
     *
     * Several tags per capability, in parallel, because the registry's task
     * vocabulary is finer than the one a person browses by: speech is
     * recognition and synthesis, vision is captioning and classification.
     */
    const tags = capability ? PIPELINE_TAGS[capability] : undefined
    /*
     * One request per (task, format) pair, and the pairs are POSITIONAL.
     *
     * Cursors are carried back as an array indexed the same way, so a
     * continuation resumes each pair where it stopped. Building the list once
     * and mapping over it twice — here and for the cursors — is what keeps
     * those two indexes in step; two hand-written loops would be free to
     * disagree, and the symptom would be a page silently restarting.
     */
    const requests: { tag: string | undefined; format: string | undefined }[] = []
    for (const tag of tags && tags.length > 0 ? tags : [undefined]) {
        if (runnable) for (const format of RUNNABLE_FORMATS) requests.push({ tag, format })
        else requests.push({ tag, format: undefined })
    }

    const fetched = await Promise.all(requests.map((request, at) =>
        hfPage(doFetch, query, request.tag, cursors?.[at], request.format)))

    // One cursor per tag, positionally: a continuation hands them back so each
    // task carries on from where it stopped rather than restarting.
    out.cursors = fetched.map(page => page.next)
    const pages = fetched.map(page => page.models)

    // Merged and deduplicated: a repository tagged for two tasks comes back
    // from both pages, and the same model twice is a bug a person can see.
    const seen = new Set<string>()
    const raw: HfModel[] = []
    for (const page of pages) {
        for (const model of page) {
            if (seen.has(model.modelId)) continue
            seen.add(model.modelId)
            raw.push(model)
        }
    }

    return raw.map(model => {
        const parsed = parseSpecifier(`hf:${model.modelId}`)
        return {
            id: parsed.id,
            name: parsed.name,
            owner: parsed.owner,
            source: "huggingface" as const,
            // Read from the repository's own format tags. Which FILE is the
            // weight still needs the file tree, but WHETHER anything here could
            // run one is answerable from the listing — and a row that knows it
            // is unrunnable can say so before you open it.
            runtime: runtimeFromTags(model.tags),
            type: engineType(model.pipeline_tag),
            capability: capabilityOf(model.pipeline_tag),
            // Direction, not just the shelf: "speech" covers recognition and
            // synthesis, which are opposites. See modalitiesOf().
            in: modalitiesOf(model.pipeline_tag).in,
            out: modalitiesOf(model.pipeline_tag).out,
            // A listing reports no size — that needs the file tree, which is a
            // request per model. Null rather than zero: unknown and empty are
            // different facts.
            bytes: null,
            path: null,
            cached: false,
            resident: false,
            description: model.pipeline_tag ?? null,
            downloads: model.downloads ?? null,
            likes: model.likes ?? null,
            updatedAt: model.createdAt ? Date.parse(model.createdAt) : null,
            // Judged by the caller, which is the only place the machine's
            // ceiling is known. A catalogue row is the same on every box.
            fit: "unknown" as const,
            estimatedBytes: estimateBytes(parsed.name),
        }
    })
}

/** One page of the registry, optionally scoped to a task. */
async function hfPage(
    doFetch: typeof fetch,
    query: string,
    tag: string | undefined,
    cursor?: string | null,
    format?: string,
): Promise<{ models: HfModel[]; next: string | null }> {
    const params = new URLSearchParams({
        search: query,
        limit: "100",
        sort: "downloads",
        direction: "-1",
    })
    if (tag) params.set("pipeline_tag", tag)
    // `filter` matches the repository's TAGS, which is where Hugging Face
    // records that a repo ships a GGUF or an ONNX export. `library` looks like
    // it would do this and is silently ignored — it returns the unfiltered
    // list, which is the failure mode where the filter appears to work.
    if (format) params.set("filter", format)
    if (cursor) params.set("cursor", cursor)

    const response = await doFetch(`https://huggingface.co/api/models?${params}`)
    if (!response.ok) throw new Error(`huggingface search failed: ${response.status}`)

    return {
        models: (await response.json()) as HfModel[],
        next: nextCursor(response.headers.get("link")),
    }
}

/**
 * The cursor for the next page, out of a Link header.
 *
 * Hugging Face pages by opaque cursor and publishes no total anywhere, so this
 * is the only way past the first hundred rows — and the reason a count in a UI
 * can only ever describe what has been loaded, never what exists.
 */
function nextCursor(link: string | null): string | null {
    if (!link) return null
    const match = /<([^>]+)>;\s*rel="next"/.exec(link)
    if (!match) return null
    try {
        return new URL(match[1]!).searchParams.get("cursor")
    } catch {
        return null
    }
}

/**
 * The registry's task tags behind each capability someone browses by.
 *
 * Two apiece, deliberately: enough to cover the halves of a capability that are
 * genuinely different jobs, few enough that choosing a scope stays two requests
 * rather than six.
 */
const PIPELINE_TAGS: Record<ModelCapability, string[]> = {
    chat: ["text-generation", "text2text-generation"],
    speech: ["automatic-speech-recognition", "text-to-speech"],
    embedding: ["sentence-similarity", "feature-extraction"],
    vision: ["image-text-to-text", "image-classification"],
    other: [],
}

/**
 * The repository tags for formats this daemon has an adapter for.
 *
 * Asked of the REGISTRY rather than filtered out of a general answer. Measured
 * against the live catalogue, the unfiltered top-200 of a scope is 12-37%
 * runnable — the rest are PyTorch checkpoints with no ONNX export and no GGUF
 * quantisation, which nothing local can execute and no adapter work will
 * change. A page of those is a page of things that cannot be downloaded
 * usefully.
 *
 * A UNION, which is why it is a list and not the single `filter=onnx` this
 * once had: that was written when ONNX was the only adapter and was rightly
 * dropped when llama.cpp landed, because it hid every GGUF. One request per
 * format, merged — Hugging Face ANDs repeated filters, so there is no way to
 * ask for "either" in one call.
 */
const RUNNABLE_FORMATS = ["gguf", "onnx"] as const

/** ONNX and GGUF have adapters; everything else is a weight nothing here executes. */
function runtimeFromTags(tags: string[] | undefined): ModelRuntime | null {
    const has = (tag: string) => (tags ?? []).includes(tag)
    if (has("onnx")) return "onnx"
    if (has("gguf")) return "llama.cpp"
    return null
}

/**
 * Ollama's library.
 *
 * The types have modelled `source: "ollama"` since the beginning and nothing
 * ever searched it — the catalogue was Hugging Face alone, which made "both
 * registries in one place" true of the type and false of the product.
 *
 * `ollama.com/api/tags` is the published library rather than a search endpoint,
 * so it is fetched whole and filtered here. It is a curated list of tens, not
 * the hundreds of thousands on Hugging Face, and that is the point of it.
 *
 * A failure is empty, not a throw: Ollama being unreachable must not take the
 * Hugging Face half of a search down with it.
 */
async function searchOllama(
    doFetch: typeof fetch,
    query: string,
    capability?: ModelCapability,
): Promise<ModelRecord[]> {
    // Its library is language models, so any other scope excludes it entirely
    // rather than returning things filed under a capability they do not have.
    if (capability && capability !== "chat") return []

    try {
        const response = await doFetch("https://ollama.com/api/tags")
        if (!response.ok) return []

        const raw = (await response.json()) as { models?: { name?: string; size?: number }[] }
        const q = query.trim().toLowerCase()

        return (raw.models ?? [])
            .filter(model => !!model.name && (q === "" || model.name.toLowerCase().includes(q)))
            .map(model => {
                const parsed = parseSpecifier(`ollama:${model.name}`)
                return {
                    id: parsed.id,
                    name: parsed.name,
                    owner: "ollama",
                    source: "ollama" as const,
                    runtime: "ollama" as ModelRuntime,
                    type: "generate" as EngineType,
                    // Ollama's library is language models. Saying so is more
                    // useful than "other", and more honest than reading a task
                    // tag it does not publish.
                    capability: "chat" as ModelCapability,
                    // Same reasoning as the capability above: Ollama's library
                    // is language models, so text in and text out is a fact
                    // about the library rather than a guess about a tag.
                    in: ["text"] as Modality[],
                    out: ["text"] as Modality[],
                    // Zero means "not published", not "empty". See fitFor.
                    bytes: model.size && model.size > 0 ? model.size : null,
                    path: null,
                    cached: false,
                    resident: false,
                    description: null,
                    downloads: null,
                    likes: null,
                    updatedAt: null,
                    fit: "unknown" as const,
                    estimatedBytes: estimateBytes(parsed.name),
                }
            })
    } catch {
        return []
    }
}

/**
 * HF's pipeline tag → the kernel's own vocabulary.
 *
 * A lossy map on purpose. HF publishes ~60 task tags because they are
 * DISCOVERY labels; `EngineType` has three because they are interaction
 * patterns — how a caller holds the thing, not what it is for. Summarisation
 * and translation are both `generate` with a different prompt.
 *
 * `transform` is the default because one-shot in, one-shot out covers most of
 * what an ONNX export is: embeddings, classifiers, detection, ASR.
 */
function engineType(tag: string | undefined): EngineType {
    if (!tag) return "transform"
    if (tag.includes("text-generation") || tag.includes("text2text")) return "generate"
    if (tag.includes("voice-activity")) return "stream"
    return "transform"
}

/**
 * What a task tag takes in and gives back.
 *
 * `capability` is deliberately coarse — it is a browsing bucket, and "speech"
 * is one shelf you look on. That makes it the WRONG thing to route on:
 * recognition and synthesis are both "speech" and are opposites, so a
 * dictation surface filtering by capability offered Kokoro as a transcriber.
 *
 * Direction is what separates them, and `Modality[]` is the vocabulary the
 * kernel already has for it. Derived here beside `capabilityOf` because both
 * read the same tag, and a second place that interprets task tags is a second
 * place they can be interpreted differently.
 *
 * Unknown stays EMPTY rather than guessing text→text. An empty modality list
 * means "nobody wrote this down", which readers can act on; a wrong one is a
 * confident lie about what a model does.
 */
export function modalitiesOf(tag: string | undefined): { in: Modality[]; out: Modality[] } {
    if (!tag) return { in: [], out: [] }
    const t = tag.toLowerCase()

    if (t.includes("automatic-speech-recognition") || t.includes("speech-to-text")) {
        return { in: ["audio"], out: ["text"] }
    }
    if (t.includes("text-to-speech") || t.includes("text-to-audio")) {
        return { in: ["text"], out: ["audio"] }
    }
    if (t.includes("audio-classification") || t.includes("voice-activity")) {
        return { in: ["audio"], out: ["text"] }
    }
    if (t.includes("image-text-to-text")) return { in: ["image", "text"], out: ["text"] }
    if (t.includes("image-classification") || t.includes("object-detection")) {
        return { in: ["image"], out: ["text"] }
    }
    if (t.includes("text-to-image")) return { in: ["text"], out: ["image"] }
    if (t.includes("sentence-similarity") || t.includes("feature-extraction") || t.includes("embedding")) {
        return { in: ["text"], out: ["vector"] }
    }
    if (t.includes("text-generation") || t.includes("text2text") || t.includes("conversational")) {
        return { in: ["text"], out: ["text"] }
    }
    return { in: [], out: [] }
}

/**
 * The task tag, read as a capability someone would browse by.
 *
 * Substring matching on purpose: Hugging Face's tags are a long open list
 * (`automatic-speech-recognition`, `audio-classification`, `text-to-speech`)
 * and new ones appear without warning. Matching on the family keeps a new tag
 * landing in the right bucket instead of vanishing, and anything genuinely
 * unrecognised becomes "other" rather than being filed somewhere wrong.
 *
 * Order matters where families overlap: `image-text-to-text` is a vision model
 * that also mentions text, so vision is tested before chat.
 */
export function capabilityOf(tag: string | undefined): ModelCapability {
    if (!tag) return "other"
    const t = tag.toLowerCase()

    if (t.includes("image") || t.includes("visual") || t.includes("depth") || t.includes("object-detection")) return "vision"
    if (t.includes("audio") || t.includes("speech") || t.includes("voice") || t.includes("text-to-audio")) return "speech"
    if (t.includes("sentence-similarity") || t.includes("feature-extraction") || t.includes("embedding")
        || t.includes("reranking") || t.includes("cross-encoder")) return "embedding"
    if (t.includes("text-generation") || t.includes("text2text") || t.includes("conversational")) return "chat"
    return "other"
}

/** The fields this reads from a Hugging Face listing. Everything else is ignored. */
type HfModel = {
    modelId: string
    pipeline_tag?: string
    downloads?: number
    likes?: number
    createdAt?: string
    tags?: string[]
}

/** One repository as HF reports it, with the extras a detail page needs. */
export type RepoDetail = {
    id: string
    name: string
    owner: string
    type: EngineType
    capability: ModelCapability
    /** What it takes in and gives back — the only thing separating recognition from synthesis. */
    in: Modality[]
    out: Modality[]
    license: string | null
    library: string | null
    baseModel: string | null
    datasets: string[]
    tags: string[]
    /** Total bytes the repository occupies, as the registry reports it. */
    storage: number | null
    /** Parameter count, where the registry knows it. */
    params: number | null
    downloads: number | null
    likes: number | null
    updatedAt: number | null
    /** Every .onnx file the repository publishes. */
    weights: string[]
    /** The card, as authored. Null when the repository ships none. */
    readme: string | null
}

/**
 * One repository in full — what a detail buffer renders.
 *
 * Separate from `search`, which answers about MANY repositories and therefore
 * cannot afford a card fetch each. This is the single-subject read: metadata
 * and file list in one call, the card in a second, both for the one thing
 * being looked at.
 *
 * The card is fetched with its own tolerance: a repository without a README is
 * ordinary, so a 404 there yields `readme: null` rather than failing the whole
 * record. A failure of the METADATA call still throws — that one means the
 * repository could not be read at all.
 */
export async function repo(specifier: string, doFetch: typeof fetch = fetch): Promise<RepoDetail> {
    const name = specifier.replace(/^hf:/, "").split("@")[0]!
    const response = await doFetch(`https://huggingface.co/api/models/${name}`)
    if (!response.ok) throw new Error(`huggingface model failed: ${response.status}`)

    const raw = (await response.json()) as {
        modelId?: string
        pipeline_tag?: string
        downloads?: number
        likes?: number
        lastModified?: string
        usedStorage?: number
        tags?: string[]
        safetensors?: { total?: number }
        cardData?: {
            license?: string | string[]
            library_name?: string
            base_model?: string | string[]
            datasets?: string | string[]
            language?: string | string[]
        }
        siblings?: { rfilename: string }[]
    }

    const parsed = parseSpecifier(`hf:${name}`)
    const siblings = (raw.siblings ?? []).map(sibling => sibling.rfilename)

    return {
        id: parsed.id,
        name: parsed.name,
        owner: parsed.owner,
        type: engineType(raw.pipeline_tag),
        capability: capabilityOf(raw.pipeline_tag),
        in: modalitiesOf(raw.pipeline_tag).in,
        out: modalitiesOf(raw.pipeline_tag).out,
        downloads: raw.downloads ?? null,
        likes: raw.likes ?? null,
        updatedAt: raw.lastModified ? Date.parse(raw.lastModified) : null,
        // Every format something could run, not just ONNX. A repository
        // shipping safetensors or GGUF reported zero weight files, which read
        // as "this publishes nothing" for most of Hugging Face.
        weights: siblings.filter(file => RUNNABLE.some(ext => file.toLowerCase().endsWith(ext))),
        // Read from the API's own structured fields rather than parsed out of
        // the card's front matter. The registry publishes both, and the YAML
        // is the copy — it is also what was being rendered as the first twenty
        // lines of every model page, because a card shown verbatim shows its
        // own metadata block.
        license: first(raw.cardData?.license),
        library: raw.cardData?.library_name ?? null,
        baseModel: first(raw.cardData?.base_model),
        datasets: list(raw.cardData?.datasets),
        // The published tag list minus the ones that restate fields already on
        // this record. A tag row repeating the licence and the library beside
        // the licence and the library is noise.
        tags: (raw.tags ?? []).filter(tag =>
            !tag.includes(":") && tag !== raw.cardData?.library_name && tag !== raw.pipeline_tag),
        storage: raw.usedStorage ?? null,
        params: raw.safetensors?.total ?? null,
        readme: siblings.includes("README.md") ? body(await card(name, doFetch)) : null,
    }
}

/** A field the registry publishes as either one value or a list. */
function first(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
}

function list(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) return value
    return value ? [value] : []
}

/**
 * The card without its front matter.
 *
 * Everything between the opening and closing `---` is metadata this record
 * already carries as fields, and rendering it verbatim put a wall of YAML
 * above the prose on every model page. Only a fence on the FIRST line counts:
 * a horizontal rule further down is content.
 */
function body(readme: string | null): string | null {
    if (!readme) return null
    if (!readme.startsWith("---")) return readme

    const end = readme.indexOf("\n---", 3)
    if (end === -1) return readme
    return readme.slice(readme.indexOf("\n", end + 1) + 1).replace(/^\s+/, "")
}

/** The rendered model card. Null rather than throwing — a missing card is not a failure. */
async function card(name: string, doFetch: typeof fetch): Promise<string | null> {
    const response = await doFetch(`https://huggingface.co/${name}/raw/main/README.md`)
    if (!response.ok) return null
    return await response.text()
}

/**
 * The weight files a repository publishes, newest listing first.
 *
 * A repository is not a model: `onnx-community/silero-vad` ships eight ONNX
 * files — the base graph plus seven quantisations — and downloading "the
 * model" means choosing one. Listing them is what lets a caller choose rather
 * than having a guess made for it.
 */
export async function files(specifier: string, doFetch: typeof fetch = fetch): Promise<string[]> {
    const repo = specifier.replace(/^hf:/, "").split("@")[0]
    const response = await doFetch(`https://huggingface.co/api/models/${repo}`)
    if (!response.ok) throw new Error(`huggingface model failed: ${response.status}`)

    const raw = (await response.json()) as { siblings?: { rfilename: string }[] }

    // EVERY file, unfiltered. This returned `.onnx` only — written when ONNX
    // was the one adapter — which meant `preferred()` chose from a list the
    // real weight had already been removed from: `hexgrad/Kokoro-82M` ships
    // `kokoro-v1_0.pth` and was refused as publishing nothing runnable.
    //
    // Listing and choosing are different jobs. This lists; `preferred` decides,
    // and it is the only place that knows which formats have adapters.
    return (raw.siblings ?? []).map(sibling => sibling.rfilename)
}

/**
 * Which file to fetch when a caller names a repository and not a weight.
 *
 * `onnx/model.onnx` is the transformers.js export convention, and a repository
 * that follows it has exactly one base graph beside its quantisations. That is
 * the case this answers, and the unquantised graph is the right default:
 * picking a quantisation is a quality decision belonging to whoever runs it.
 *
 * ── Null is the answer for a multi-part model ───────────────────────────────
 *
 * An encoder-decoder export — every Whisper repository — ships
 * `encoder_model.onnx` and `decoder_model.onnx` and needs BOTH. There is no
 * single file to fetch, and returning one would download half a model that
 * fails at load with something obscure.
 *
 * So this refuses rather than guessing, and the caller names the file it
 * wants. A shortest-path heuristic was tried and picked `decoder_model.onnx`
 * for Whisper, which is exactly the silent half-answer this exists to avoid.
 */
export function preferred(names: string[]): string | null {
    // Exact conventional names first: a repository publishing one of these
    // means it, and guessing past it would pick a quantisation or a variant
    // over the file the publisher nominated.
    const nominated = names.find(name => name === "onnx/model.onnx" || name === "model.onnx")
    if (nominated) return nominated

    // Then whatever single runnable weight the repository publishes.
    //
    // The narrow list above was the whole picker, which meant a repository
    // shipping `model_q4.onnx`, a GGUF quantisation, or safetensors was
    // refused as having "no single weight" — not because it had several, but
    // because none of them were spelled the one way this knew. Most models are
    // in that position, so most models could not be fetched.
    const runnable = names.filter(name => RUNNABLE.some(ext => name.toLowerCase().endsWith(ext)))
    if (runnable.length === 0) return null

    /*
     * A weight at the repository ROOT outranks anything nested.
     *
     * `hexgrad/Kokoro-82M` publishes one model — `kokoro-v1_0.pth` — beside
     * fifty-four `voices/*.pt` embeddings. Every one of those matched the
     * extension test, so the repository looked like fifty-five competing
     * weights and was refused as ambiguous. It is not ambiguous: the model is
     * at the root and the rest are assets it uses.
     *
     * Nested files are auxiliary far more often than they are alternatives —
     * `voices/`, `assets/`, `examples/` — so the root is where a publisher puts
     * the thing they mean.
     */
    const atRoot = runnable.filter(name => !name.includes("/"))
    if (atRoot.length === 1) return atRoot[0]!
    if (atRoot.length > 1) return single(atRoot)

    return single(runnable)
}

/**
 * What a set-based runtime needs out of a repository.
 *
 * ── Why a repository, not a file ────────────────────────────────────────────
 *
 * An ONNX export is not a runnable model on its own. `onnx-community/
 * whisper-tiny.en` ships forty-one files: thirteen small JSON and text files
 * at the root that describe how to tokenise, normalise and generate, and
 * twenty-eight weights under `onnx/`. transformers.js reads the first group
 * to turn a person's words into tensors, which is precisely the step the raw
 * ONNX adapter cannot do and reports as "named tensors, not text".
 *
 * So a plan is: every configuration file, plus ONE COHERENT SET of weights.
 *
 * ── Why coherence is the hard part ──────────────────────────────────────────
 *
 * Those twenty-eight weights are an encoder and a decoder in several
 * quantisations. Whisper needs both halves, and it needs them at the SAME
 * quantisation — `encoder_model.onnx` beside `decoder_model_merged_q4.onnx`
 * is a broken model rather than a slow one, and it fails at inference with a
 * shape error rather than at download with a sentence. Picking a variant is
 * therefore a decision about the whole set, never per file.
 *
 * ── Why unquantised is the default ──────────────────────────────────────────
 *
 * It is the one variant every repository publishes, and the one whose output
 * matches what the publisher benchmarked. Quantisations are a size/quality
 * trade the person downloading should make deliberately; defaulting to the
 * smallest would silently hand someone a worse model to save disk they may
 * not care about. `variant` exists so a picker can offer the choice.
 *
 * ── This is a heuristic, and says so ────────────────────────────────────────
 *
 * There is no manifest in a Hugging Face repository saying which files a
 * runtime needs; it is convention, and conventions have exceptions. The
 * failure mode is chosen to be loud: a missing configuration file fails at
 * LOAD with the file named by the runtime that wanted it, which is a better
 * error than anything this could produce by guessing harder.
 */
export function plan(names: string[], variant = ""): { files: string[]; primary: string } | null {
    const weights = names.filter(name => name.toLowerCase().endsWith(".onnx"))
    if (weights.length === 0) return null

    // Group by variant so a choice applies to every weight at once.
    const grouped = new Map<string, string[]>()
    for (const name of weights) {
        const key = variantOf(name)
        grouped.set(key, [...(grouped.get(key) ?? []), name])
    }

    const chosen = grouped.get(variant)
        // An asked-for variant this repository does not publish falls back to
        // unquantised rather than to nothing: the model is still runnable,
        // just not in the size that was requested.
        ?? grouped.get("")
        // And a repository that publishes ONLY quantisations has no
        // unquantised set to fall back to. Sorted so the choice is the same
        // on every machine rather than however the registry happened to list.
        ?? [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))[0]?.[1]
    if (!chosen || chosen.length === 0) return null

    /*
     * External data files travel with their weight.
     *
     * ONNX splits any model over 2GB into a graph and a sibling `.onnx_data`
     * holding the tensors. Fetching the graph alone produces a file that
     * loads and then fails looking for data that was never downloaded.
     */
    const data = names.filter(name => name.toLowerCase().endsWith(".onnx_data")
        && chosen.some(weight => name.startsWith(weight)))

    /*
     * The merged decoder supersedes the two-file form.
     *
     * ONNX exports of encoder-decoder models publish BOTH `decoder_model` +
     * `decoder_with_past_model` and the newer `decoder_model_merged` that is
     * the two of them in one graph. transformers.js takes the merged one
     * where it exists, so shipping the pair alongside is download with no
     * reader — about a third of a Whisper set.
     *
     * This is the ONLY alternative-form rule here, and it stays that way
     * deliberately. Extra weights in the directory are INERT: the runtime
     * loads by name, so a file it does not want costs disk and nothing else.
     * That makes over-including the safe direction and a clever exclusion
     * rule the dangerous one — the failure mode of dropping the wrong file is
     * a model that cannot load at all.
     */
    const merged = chosen.some(name => /_merged/i.test(name))
    const kept = merged
        ? chosen.filter(name => !/_with_past_model/i.test(name)
            && !/decoder_model(?!_merged)/i.test(name))
        : chosen

    const config = names.filter(isConfig)

    return {
        files: [...config, ...kept, ...data],
        primary: primaryOf(kept),
    }
}

/**
 * The quantisation suffix on a weight name, or "" for unquantised.
 *
 * Read off the END of the stem rather than by searching for a token anywhere
 * in it, because `decoder_model_merged` contains `merged` and a substring
 * test would invent a "merged" variant that separates the two halves of one
 * model — exactly the incoherent set this exists to prevent.
 */
function variantOf(name: string): string {
    const stem = name.slice(0, -".onnx".length)
    for (const suffix of QUANTISATIONS) {
        if (stem.toLowerCase().endsWith(`_${suffix}`)) return suffix
    }
    return ""
}

/**
 * Suffixes Hugging Face's ONNX exports use.
 *
 * LONGEST FIRST, and the order is load-bearing: `q8f16` read as `f16` — or
 * worse, matched by nothing — files a quantisation under the unquantised
 * variant. Measured against `onnx-community/Kokoro-82M-ONNX`, an incomplete
 * list did exactly that and pulled `model_q8f16` and `model_uint8f16` into
 * the base set, tripling the download for no benefit.
 *
 * A missing entry is therefore a silent size regression rather than a
 * failure, which is why this list is worth keeping current and worth sorting
 * by length rather than by hand.
 */
const QUANTISATIONS = [
    "uint8f16", "quantized", "q4f16", "q8f16", "bnb4", "int8", "uint8",
    "fp16", "fp32", "q4", "q8",
].sort((a, b) => b.length - a.length)

/**
 * Which file in the set is "the weight", for a caller that wants one path.
 *
 * Only used as the set's address and its liveness check — transformers.js is
 * handed the directory and finds its own way around. A decoder outranks an
 * encoder because a repository that ships only one of the two ships the
 * decoder, so this is the file whose absence really does mean "not cached".
 */
function primaryOf(weights: string[]): string {
    const sorted = [...weights].sort()
    return sorted.find(name => /_merged/i.test(name))
        ?? sorted.find(name => /(^|\/)model[^/]*\.onnx$/i.test(name))
        ?? sorted.find(name => /decoder/i.test(name))
        ?? sorted[0]!
}

/**
 * Configuration a runtime reads beside the weights.
 *
 * By location and extension rather than by an allow-list of names: repositories
 * carry `merges.txt`, `vocab.json`, `normalizer.json` and others that vary by
 * architecture, and a list of the ones we happened to have seen would quietly
 * break the next family. These files are kilobytes, so taking one too many
 * costs nothing and missing one costs a load failure.
 *
 * Root level only — a nested JSON belongs to whatever directory holds it.
 */
function isConfig(name: string): boolean {
    if (name.includes("/")) return false
    if (/^readme|^\.git|^license/i.test(name)) return false
    return /\.(json|txt|model)$/i.test(name)
}

/**
 * One candidate out of several, or null when the choice is genuinely the
 * caller's.
 *
 * A repository publishing eight quantisations has no single weight, and
 * picking one would silently hand someone a size they did not choose. Naming
 * the file is their job then, which `fetch` already accepts and the detail
 * page can now offer.
 */
function single(names: string[]): string | null {
    if (names.length === 1) return names[0]!

    // Unless the extras are shards of one weight, which is a single logical
    // model split for transport rather than a choice between models.
    const whole = names.filter(name => !SHARD.test(name))
    return whole.length === 1 ? whole[0]! : null
}

/**
 * Extensions something on this machine could plausibly execute.
 *
 * `.bin` is deliberately ABSENT. The adapter contract names it as the
 * ambiguous case — "a GGUF, a PyTorch checkpoint and a whisper.cpp weight
 * depending on who wrote it" — and in practice it is overwhelmingly the
 * PyTorch one. Including it meant `facebook/opt-125m` resolved to
 * `pytorch_model.bin`, so 239MB was downloaded that no adapter would ever
 * claim: `claims()` reads GGUF magic bytes and would refuse it at load.
 *
 * Downloading something unloadable is worse than refusing to guess. A `.bin`
 * that genuinely is a GGUF can still be fetched by naming it, which is what
 * the `file` argument is for.
 */
const RUNNABLE = [".onnx", ".gguf", ".safetensors", ".pt", ".pth"]

/** `model-00001-of-00004.safetensors` and friends — parts, not alternatives. */
const SHARD = /-\d{2,5}-of-\d{2,5}\./
