import { parseSpecifier } from "./specifier"
import { estimateBytes } from "./fit"
import type { EngineType, Modality } from "@arcforge/types"
import type { ModelCapability, ModelRecord, ModelRuntime } from "./types"

export function record(input: {
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
