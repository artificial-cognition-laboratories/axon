import type { EngineType, Modality } from "@arcforge/types"
import type { ModelRuntime } from "../types"
import { parseSpecifier } from "../specifier"
import { estimateBytes } from "../fit"
import type { ModelCapability, ModelRecord } from "../types"
import { Artifacts } from "./artifacts"
import { Metadata } from "./metadata"

/** Query provider registries with task/format filters and continuation cursors. */
export function Sources(opts: { fetch: typeof fetch }) {
    const metadata = Metadata()
    const artifacts = Artifacts()
const PIPELINE_TAGS: Record<ModelCapability, string[]> = {
    chat: ["text-generation"],
    speech: ["automatic-speech-recognition", "text-to-speech"],
    embedding: ["sentence-similarity", "feature-extraction"],
    vision: ["image-text-to-text", "image-classification"],
    other: [],
}

const RUNNABLE_FORMATS = ["gguf", "onnx"] as const

    return { search: (query: string, capability?: ModelCapability, cursors?: (string | null)[], runnable = false) => search(opts.fetch, query, capability, cursors, runnable) }

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
        cursors || runnable ? Promise.resolve([] as ModelRecord[]) : searchOllama(doFetch, query, capability),
    ])

    return { models: [...ollama, ...hugging], cursors: out.cursors }
}

async function searchHuggingFace(
    doFetch: typeof fetch,
    query: string,
    capability: ModelCapability | undefined,
    cursors: (string | null)[] | undefined,
    out: { cursors: (string | null)[] },
    runnable = false,
): Promise<ModelRecord[]> {
    
    const tags = capability ? PIPELINE_TAGS[capability] : undefined
    
    const requests: { tag: string | undefined; format: string | undefined }[] = []
    for (const tag of tags && tags.length > 0 ? tags : [undefined]) {
        if (runnable) for (const format of RUNNABLE_FORMATS) requests.push({ tag, format })
        else requests.push({ tag, format: undefined })
    }

    const fetched = await Promise.all(requests.map((request, at) =>
        cursors && cursors[at] === null
            ? Promise.resolve({ models: [] as HfModel[], next: null })
            : hfPage(doFetch, query, request.tag, cursors?.[at], request.format)))

    out.cursors = fetched.map(page => page.next)
    const pages = fetched.map(page => page.models)

    const seen = new Set<string>()
    const raw: HfModel[] = []
    for (const page of pages) {
        for (const model of page) {
            if (seen.has(model.modelId)) continue
            seen.add(model.modelId)
            raw.push(model)
        }
    }

    return raw.filter(model => !runnable || artifacts.chat((model.siblings ?? []).map(file => file.rfilename)) !== null).map(model => {
        const parsed = parseSpecifier(`hf:${model.modelId}`)
        return {
            id: parsed.id,
            name: parsed.name,
            owner: parsed.owner,
            source: "huggingface" as const,
            runtime: metadata.runtimeFromTags(model.tags),
            type: metadata.engineType(model.pipeline_tag),
            capability: metadata.capabilityOf(model.pipeline_tag),
            in: metadata.modalitiesOf(model.pipeline_tag).in,
            out: metadata.modalitiesOf(model.pipeline_tag).out,
            bytes: null,
            path: null,
            cached: false,
            resident: false,
            description: model.pipeline_tag ?? null,
            downloads: model.downloads ?? null,
            likes: model.likes ?? null,
            updatedAt: model.createdAt ? Date.parse(model.createdAt) : null,
            fit: "unknown" as const,
            estimatedBytes: estimateBytes(parsed.name),
        }
    })
}

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
        ...(format ? { full: "true" } : {}),
    })
    if (tag) params.set("pipeline_tag", tag)
    if (format) params.set("filter", format)
    if (cursor) params.set("cursor", cursor)

    const response = await doFetch(`https://huggingface.co/api/models?${params}`)
    if (!response.ok) throw new Error(`huggingface search failed: ${response.status}`)

    return {
        models: (await response.json()) as HfModel[],
        next: nextCursor(response.headers.get("link")),
    }
}

function nextCursor(link: string | null): string | null {
    if (!link) return null
    const match = /<([^>]+)>;\s*rel="next"/.exec(link)
    if (!match) return null
    return new URL(match[1]!).searchParams.get("cursor")
}

async function searchOllama(
    doFetch: typeof fetch,
    query: string,
    capability?: ModelCapability,
): Promise<ModelRecord[]> {
    if (capability && capability !== "chat") return []

    try {
        const response = await doFetch("https://ollama.com/api/tags")
        if (!response.ok) throw new Error(`ollama search failed: ${response.status}`)

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
                    capability: "chat" as ModelCapability,
                    in: ["text"] as Modality[],
                    out: ["text"] as Modality[],
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
    } catch (cause) {
        throw new Error("Ollama catalogue request failed", { cause: cause })
    }
}
}

type HfModel = {
    siblings?: { rfilename: string }[]
    modelId: string
    pipeline_tag?: string
    downloads?: number
    likes?: number
    createdAt?: string
    tags?: string[]
}
