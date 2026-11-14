import { err } from "@arcforge/err"
import { MODALITIES, type EngineCapability, type EngineType, type Modality } from "@arcforge/types"
import type { ModelStoreT } from "@arcforge/platform/build/project"
import type { AdaptersT } from "../adapter"
import type { ModelCapability, ModelRecord } from "../types"
import { Artifacts } from "../catalog"
import { record } from "../record"

/** Describe the complete weights on disk, narrowing persisted metadata at the boundary. */
export function Inventory(opts: { store: ModelStoreT; adapters: AdaptersT }) {
    let current: ModelRecord[] = []
    /**
     * Why the last refresh failed, held until one succeeds.
     *
     * Every reader goes through `current`, and a failed read that left the
     * previous `[]` in place would tell each of them — and any machine asking
     * remotely — that this box has no models, when it has a store it cannot
     * read. So the failure is thrown to every reader instead.
     */
    let fault: unknown = null
    async function refresh(): Promise<ModelRecord[]> {
        let entries: Awaited<ReturnType<ModelStoreT["list"]>>
        try {
            entries = await opts.store.list()
        } catch (cause) {
            fault = cause
            throw cause
        }
        fault = null
        current = entries.map(entry => {
            const claimed = opts.adapters.for(entry.path)?.runtime ?? null
            const runtime = claimed === "llama.cpp" && !Artifacts().gguf(entry.path) ? null : claimed
            const kind = type(entry.traits?.type)
            const ability = capability(entry.traits?.capability)
            const input = modalities(entry.traits?.in)
            const output = modalities(entry.traits?.out)
            // Older GGUF records declared chat/generate but did not persist modalities.
            const legacyChat = runtime === "llama.cpp" && kind === "generate" && ability === "chat"
            return record({ model: entry.specifier, bytes: entry.bytes, path: entry.path, runtime: runtime,
                type: kind, capability: ability, in: legacyChat && input.length === 0 ? ["text"] : input,
                out: legacyChat && output.length === 0 ? ["text"] : output, cached: true, resident: false })
        })
        return current
    }
    /**
     * What this machine can offer a role: every weight on disk that a runtime
     * here can execute and that says what it takes and gives.
     *
     * Chat models keep their narrower rule (text in, text out, on a runtime
     * that can hold a conversation). Everything else — a feature encoder, a
     * segmenter, a speech model — is offered by its declared modalities; the
     * resolver matches those against what a role asks for. This was chat-only
     * once, which left a brain's declared vision models on disk, fully
     * described, and never offered to the roles that named them.
     */
    async function local(): Promise<EngineCapability[]> {
        const records = await refresh()
        return records.filter(model => model.path !== null && model.runtime !== null && offered(model))
            .map(model => ({ id: model.id, provider: "local", name: model.name, type: model.type, in: model.in, out: model.out,
                local: true, slots: 1, ...(model.bytes !== null ? { bytes: model.bytes } : {}) }))
    }
    return {
        get current(): ModelRecord[] {
            if (fault !== null) throw fault
            return current
        },
        refresh: refresh,
        local: local,
    }
}
export type InventoryT = ReturnType<typeof Inventory>

/** Whether a runnable record is something a role could be filled with. */
function offered(model: ModelRecord): boolean {
    if (model.type === "generate") {
        return model.capability === "chat" && model.in.includes("text") && model.out.includes("text")
            && (model.runtime === "llama.cpp" || model.runtime === "transformers")
    }
    return model.in.length > 0 && model.out.length > 0
}

function type(value: string | undefined): EngineType {
    if (value === undefined) return "transform"
    if (value === "generate" || value === "transform" || value === "stream") return value
    throw err("MODEL_INPUT_INVALID", { detail: `invalid stored engine type: ${value}` })
}
function capability(value: string | undefined): ModelCapability {
    if (value === undefined) return "other"
    if (value === "chat" || value === "speech" || value === "embedding" || value === "vision" || value === "other") return value
    throw err("MODEL_INPUT_INVALID", { detail: `invalid stored model capability: ${value}` })
}
function modalities(values: string[] | undefined): Modality[] {
    if (values === undefined) return []
    return values.map(value => {
        const known = MODALITIES.find(modality => modality === value)
        if (known) return known
        throw err("MODEL_INPUT_INVALID", { detail: `invalid stored modality: ${value}` })
    })
}
