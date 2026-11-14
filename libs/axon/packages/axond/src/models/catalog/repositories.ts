import type { EngineType, Modality } from "@arcforge/types"
import type { ModelCapability } from "../types"
import { parseSpecifier } from "../specifier"
import { RUNNABLE } from "./formats"
import { Metadata } from "./metadata"

export type RepoDetail = {
    id: string
    name: string
    owner: string
    type: EngineType
    capability: ModelCapability
    
    in: Modality[]
    out: Modality[]
    license: string | null
    library: string | null
    baseModel: string | null
    datasets: string[]
    tags: string[]
    
    storage: number | null
    
    params: number | null
    downloads: number | null
    likes: number | null
    updatedAt: number | null
    
    files: string[]
    weights: string[]
    sizes: Record<string, number>
    
    readme: string | null
}

/** Read authoritative metadata and complete file manifests at a repository revision. */
export function Repositories(opts: { fetch: typeof fetch }) {
    const metadata = Metadata()
    return { detail: (id: string) => repo(id, opts.fetch), files: (id: string) => files(id, opts.fetch) }

async function repo(specifier: string, doFetch: typeof fetch = fetch): Promise<RepoDetail> {
    const match = /^hf:([^/]+\/[^/@]+)(?:@([^/]+))?(?:\/.*)?$/.exec(specifier)
    if (!match) throw new Error(`Invalid Hugging Face repository: ${specifier}`)
    const name = match[1]!
    const revision = match[2] ?? "main"
    const response = await doFetch(`https://huggingface.co/api/models/${name}/revision/${encodeURIComponent(revision)}?blobs=true`)
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
        siblings?: { rfilename: string; size?: number }[]
    }

    const parsed = parseSpecifier(`hf:${name}@${revision}`)
    const siblings = (raw.siblings ?? []).map(sibling => sibling.rfilename)

    return {
        id: parsed.id,
        name: parsed.name,
        owner: parsed.owner,
        type: metadata.engineType(raw.pipeline_tag),
        capability: metadata.capabilityOf(raw.pipeline_tag),
        in: metadata.modalitiesOf(raw.pipeline_tag).in,
        out: metadata.modalitiesOf(raw.pipeline_tag).out,
        downloads: raw.downloads ?? null,
        likes: raw.likes ?? null,
        updatedAt: raw.lastModified ? Date.parse(raw.lastModified) : null,
        files: siblings,
        sizes: Object.fromEntries((raw.siblings ?? []).filter(sibling => typeof sibling.size === "number").map(sibling => [sibling.rfilename, sibling.size!])),
        weights: siblings.filter(file => RUNNABLE.some(ext => file.toLowerCase().endsWith(ext))),
        license: first(raw.cardData?.license),
        library: raw.cardData?.library_name ?? null,
        baseModel: first(raw.cardData?.base_model),
        datasets: list(raw.cardData?.datasets),
        tags: (raw.tags ?? []).filter(tag =>
            !tag.includes(":") && tag !== raw.cardData?.library_name && tag !== raw.pipeline_tag),
        storage: raw.usedStorage ?? null,
        params: raw.safetensors?.total ?? null,
        readme: siblings.includes("README.md") ? body(await card(name, revision, doFetch)) : null,
    }
}

function first(value: string | string[] | undefined): string | null {
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
}

function list(value: string | string[] | undefined): string[] {
    if (Array.isArray(value)) return value
    return value ? [value] : []
}

function body(readme: string | null): string | null {
    if (!readme) return null
    if (!readme.startsWith("---")) return readme

    const end = readme.indexOf("\n---", 3)
    if (end === -1) return readme
    return readme.slice(readme.indexOf("\n", end + 1) + 1).replace(/^\s+/, "")
}

async function card(name: string, revision: string, doFetch: typeof fetch): Promise<string | null> {
    const response = await doFetch(`https://huggingface.co/${name}/raw/${encodeURIComponent(revision)}/README.md`)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`huggingface model card failed: ${response.status}`)
    return await response.text()
}

async function files(specifier: string, doFetch: typeof fetch = fetch): Promise<string[]> {
    const repo = specifier.replace(/^hf:/, "").split("@")[0]
    const response = await doFetch(`https://huggingface.co/api/models/${repo}`)
    if (!response.ok) throw new Error(`huggingface model failed: ${response.status}`)

    const raw = (await response.json()) as { siblings?: { rfilename: string; size?: number }[] }

    return (raw.siblings ?? []).map(sibling => sibling.rfilename)
}
}
