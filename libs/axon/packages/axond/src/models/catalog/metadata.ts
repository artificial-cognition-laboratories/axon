import { shapeOfPipelineTag, type EngineType, type Modality } from "@arcforge/types"
import type { ModelCapability, ModelRuntime } from "../types"

export function Metadata() {
    return { engineType: engineType, modalitiesOf: modalitiesOf, capabilityOf: capabilityOf, runtimeFromTags: runtimeFromTags }
}

function engineType(tag: string | undefined): EngineType {
    return shapeOfPipelineTag(tag)?.type ?? "transform"
}

function modalitiesOf(tag: string | undefined): { in: Modality[]; out: Modality[] } {
    const shape = shapeOfPipelineTag(tag)
    return shape ? { in: shape.in, out: shape.out } : { in: [], out: [] }
}

function capabilityOf(tag: string | undefined): ModelCapability {
    if (!tag) return "other"
    const t = tag.toLowerCase()

    if (t.includes("image") || t.includes("visual") || t.includes("depth") || t.includes("object-detection")) return "vision"
    if (t.includes("audio") || t.includes("speech") || t.includes("voice") || t.includes("text-to-audio")) return "speech"
    if (t.includes("sentence-similarity") || t.includes("feature-extraction") || t.includes("embedding")
        || t.includes("reranking") || t.includes("cross-encoder")) return "embedding"
    if (t.includes("text-generation") || t.includes("text2text") || t.includes("conversational")) return "chat"
    return "other"
}


function runtimeFromTags(tags: string[] | undefined): ModelRuntime | null {
    const has = (tag: string) => (tags ?? []).includes(tag)
    if (has("onnx")) return "transformers"
    if (has("gguf")) return "llama.cpp"
    return null
}
