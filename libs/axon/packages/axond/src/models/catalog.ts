import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { EngineType } from "@arcforge/types"
import { parseSpecifier } from "./specifier"
import type { ModelRecord } from "./types"

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
export function Catalog(opts: CatalogOpts = {}) {
    const path = opts.root ?? join(homedir(), ".axon", "cache", "models-catalog.json")
    const doFetch = opts.fetch ?? fetch

    /** query → results. Loaded once, written on every successful fetch. */
    let cache: Record<string, ModelRecord[]> = read()

    function read(): Record<string, ModelRecord[]> {
        try {
            return existsSync(path)
                ? (JSON.parse(readFileSync(path, "utf-8")) as { queries: Record<string, ModelRecord[]> }).queries ?? {}
            : {}
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
            writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), queries: cache }), "utf-8")
        } catch {
            // A cache that cannot be written is a slow catalogue, not a broken
            // one — every query still works, it just pays the network again.
        }
    }

    return {
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
        cached(query: string): ModelRecord[] {
            return cache[key(query)] ?? []
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

            void refresh(query).then(fresh => {
                if (!fresh) return
                // Fired only on a CHANGE: a caller re-rendering on every
                // identical answer would flash a list that did not move.
                if (JSON.stringify(fresh) !== JSON.stringify(hit)) onUpdate?.(fresh)
            })

            return hit ?? []
        },

        /** Fetch one query and cache it. Null when the network failed. */
        refresh,
    }

    async function refresh(query: string): Promise<ModelRecord[] | null> {
        try {
            const models = await search(doFetch, query)
            cache = { ...cache, [key(query)]: models }
            write()
            return models
        } catch {
            // See the header: offline keeps what is cached.
            return null
        }
    }
}

export type CatalogT = ReturnType<typeof Catalog>

/** Normalised so `Whisper` and `whisper ` are one cache entry rather than three. */
function key(query: string): string {
    return query.trim().toLowerCase()
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
async function search(doFetch: typeof fetch, query: string): Promise<ModelRecord[]> {
    const params = new URLSearchParams({
        search: query,
        filter: "onnx",
        limit: "40",
        sort: "downloads",
        direction: "-1",
    })

    const response = await doFetch(`https://huggingface.co/api/models?${params}`)
    if (!response.ok) throw new Error(`huggingface search failed: ${response.status}`)

    const raw = (await response.json()) as HfModel[]
    return raw.map(model => {
        const parsed = parseSpecifier(`hf:${model.modelId}`)
        return {
            id: parsed.id,
            name: parsed.name,
            owner: parsed.owner,
            source: "huggingface" as const,
            // What can run it is not knowable from a listing: the repository
            // is tagged onnx, and which FILE inside it is the weight is only
            // answerable once fetched. Reported as unknown rather than guessed.
            runtime: null,
            type: engineType(model.pipeline_tag),
            in: [],
            out: [],
            // A listing reports no size — that needs the file tree, which is a
            // request per model. Null rather than zero: unknown and empty are
            // different facts.
            bytes: null,
            path: null,
            cached: false,
            resident: false,
            description: model.pipeline_tag ?? null,
            downloads: model.downloads ?? null,
        }
    })
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

/** The fields this reads from a Hugging Face listing. Everything else is ignored. */
type HfModel = {
    modelId: string
    pipeline_tag?: string
    downloads?: number
}

/** One repository as HF reports it, with the extras a detail page needs. */
export type RepoDetail = {
    id: string
    name: string
    owner: string
    type: EngineType
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
        siblings?: { rfilename: string }[]
    }

    const parsed = parseSpecifier(`hf:${name}`)
    const siblings = (raw.siblings ?? []).map(sibling => sibling.rfilename)

    return {
        id: parsed.id,
        name: parsed.name,
        owner: parsed.owner,
        type: engineType(raw.pipeline_tag),
        downloads: raw.downloads ?? null,
        likes: raw.likes ?? null,
        updatedAt: raw.lastModified ? Date.parse(raw.lastModified) : null,
        weights: siblings.filter(file => file.toLowerCase().endsWith(".onnx")),
        readme: siblings.includes("README.md") ? await card(name, doFetch) : null,
    }
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
    return (raw.siblings ?? [])
        .map(sibling => sibling.rfilename)
        .filter(name => name.toLowerCase().endsWith(".onnx"))
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
    return names.find(name => name === "onnx/model.onnx" || name === "model.onnx") ?? null
}
