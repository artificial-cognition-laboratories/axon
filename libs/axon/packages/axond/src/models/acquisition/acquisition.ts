import { err } from "@arcforge/err"
import { Models as Weights, type ModelStoreT, type ParsedModel } from "@arcforge/platform/build/project"
import type { CatalogT } from "../catalog"
import { Artifacts } from "../catalog"
import { parseSpecifier } from "../specifier"
import { Downloads, alreadyRunning } from "../downloads"
import type { InventoryT } from "../inventory"
import type { ResidenceT } from "../residence"
import type { ActivityT } from "../activity"
import type { ModelRecord } from "../types"

type FetchInput = string | { specifier: string; file?: string; traits?: ParsedModel["traits"] }
/** Acquire complete artifacts and record their authoritative capability metadata. */
export function Acquisition(opts: { store: ModelStoreT; catalog: CatalogT; inventory: InventoryT; residence: ResidenceT; activity: ActivityT }) {
    const artifacts = Artifacts()
    const weights = Weights({ store: opts.store })
    const downloads = Downloads()
    async function inspect(repository: string): Promise<void> {
        const detail = await opts.catalog.detail(repository)
        const wanted = parseSpecifier(repository)
        const entries = await opts.store.list()
        for (const entry of entries) {
            const parsed = parseSpecifier(entry.specifier)
            if (parsed.owner !== wanted.owner || parsed.name !== wanted.name) continue
            await opts.store.describe(entry.specifier, { capability: detail.capability, type: detail.type, in: detail.in, out: detail.out })
        }
        await opts.inventory.refresh()
    }
    async function fetch(input: FetchInput, signal?: AbortSignal, report?: (progress: { file?: string; received: number; total: number | null }) => void): Promise<ModelRecord> {
        const given = typeof input === "string" ? { specifier: input } : input
        const parsed = repository(given.specifier)
        const id = `hf:${parsed.repo}@${parsed.rev}`
        const detail = await opts.catalog.detail(id)
        signal?.throwIfAborted()
        const names = detail.files
        const selectedFile = given.file ?? parsed.file
        const candidate = selectedFile ?? artifacts.preferred(names)
        const set = !selectedFile && (!candidate || candidate.endsWith(".onnx")) ? artifacts.plan(names) : null
        const traits = given.traits ?? { capability: detail.capability, type: detail.type, in: detail.in, out: detail.out }
        let canonical: string
        if (set) {
            let done = 0
            let current = 0
            await weights.resolveSet({ host: "hf", repo: parsed.repo, rev: parsed.rev, key: parsed.repo }, set.files, set.primary, {
                traits: traits,
                ...(signal ? { signal: signal } : {}),
                onDownload: model => { done += current; current = 0; report?.({ file: model.file, received: done, total: null }) },
                onProgress: progress => { current = progress.received; report?.({ received: done + current, total: null }) },
            })
            canonical = id
        } else {
            if (!candidate || !candidate.endsWith(".gguf") && !candidate.endsWith(".onnx")) {
                throw err("MODEL_NO_SINGLE_WEIGHT", { detail: `${id} has no supported single artifact — select a GGUF weight or a complete ONNX repository` })
            }
            if (traits.capability === "chat" && candidate.endsWith(".gguf") && !artifacts.gguf(candidate)) {
                throw err("MODEL_NO_SINGLE_WEIGHT", { detail: `${candidate} is not a complete language model weight` })
            }
            report?.({ file: candidate, received: 0, total: null })
            canonical = `${id}/${candidate}`
            await weights.resolve({ weight: { hf: parsed.repo, file: candidate, rev: parsed.rev,
                ...(traits.capability ? { capability: traits.capability } : {}),
                ...(traits.type ? { type: traits.type } : {}),
                ...(traits.in ? { in: traits.in } : {}), ...(traits.out ? { out: traits.out } : {}) } }, {
                ...(signal ? { signal: signal } : {}),
                onProgress: progress => report?.({ received: progress.received, total: progress.total }),
            })
        }
        const records = await opts.inventory.refresh()
        const result = records.find(record => record.id === canonical)
        if (!result) throw err("MODEL_FETCH_FAILED", { detail: `${canonical} was acquired but could not be enumerated` })
        return result
    }
    function download(input: string | { specifier: string; file?: string }): { id: string } {
        const given = typeof input === "string" ? { specifier: input } : input
        if (downloads.inFlight(given.specifier)) alreadyRunning(given.specifier)
        const id = downloads.start(given.specifier, (report, signal) => opts.activity.run("download", given.specifier, async () => {
            const model = await fetch(given, signal, report)
            return model.id
        }), given.file)
        return { id: id }
    }
    async function remove(model: string): Promise<boolean> {
        return opts.activity.run("remove", model, async () => {
            if (downloads.list().some(download => (download.state === "downloading" || download.state === "cancelling") && sameRepository(download.model, model))) {
                throw err("MODEL_DOWNLOAD_RUNNING", { detail: `${model} has a download in progress — cancel it before removing` })
            }
            return opts.residence.remove(model, async () => {
                const result = await opts.store.remove(model)
                await opts.inventory.refresh()
                return result
            })
        })
    }
    return {
        fetch: (input: FetchInput) => opts.activity.run("fetch", typeof input === "string" ? input : input.specifier, () => fetch(input)),
        inspect: (id: string) => opts.activity.run("inspect", id, () => inspect(id)),
        remove: remove, download: download,
        downloads: downloads.list, cancelDownload: downloads.cancel, dismissDownload: downloads.dismiss,
    }
}
export type AcquisitionT = ReturnType<typeof Acquisition>

function repository(specifier: string): { repo: string; rev: string; file?: string } {
    const match = /^hf:([^/]+)\/([^/@]+)(?:@([^/]+))?(?:\/(.+))?$/.exec(specifier)
    if (!match) throw err("MODEL_SPECIFIER_INVALID", { detail: `${specifier} must name a Hugging Face repository; select its file separately` })
    return { repo: `${match[1]}/${match[2]}`, rev: match[3] ?? "main", ...(match[4] ? { file: match[4] } : {}) }
}
function sameRepository(left: string, right: string): boolean {
    const a = parseSpecifier(left)
    const b = parseSpecifier(right)
    return a.scheme === b.scheme && a.owner === b.owner && a.name === b.name
}
