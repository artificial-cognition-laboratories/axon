import type { EngineType, Modality } from "@arcforge/types"

/**
 * What a model can do, as its own source describes it — turned into the
 * vocabulary a requirement is written in.
 *
 * Every provider knows this about its own models and says so differently:
 * OpenRouter publishes input/output modality arrays, Ollama reports
 * capability strings, Hugging Face stamps a `pipeline_tag`. None of them is
 * guessed here. A source that cannot say what a model does contributes
 * nothing rather than a hopeful default — a model bound to a role it cannot
 * serve fails at the first call, which is the one place this system must
 * never fail.
 */

/** One classified model shape — what a role's `type`/`in`/`out` match against. */
export type ModelShape = {
    type: EngineType
    in: Modality[]
    out: Modality[]
}

const TEXT: ModelShape = { type: "generate", in: ["text"], out: ["text"] }

/**
 * Hugging Face `pipeline_tag` → shape.
 *
 * The hub publishes ~60 task tags; this maps the ones Axon has a handle
 * shape for. The absences are the design: an unmapped tag is a model we
 * cannot call, so it never enters a catalogue and `axon prepare` says the
 * kind is unsupported. Growing this table is how a new capability arrives —
 * and a tag whose shape needs a verb we do not have (a fourth EngineType)
 * cannot be added here alone, which is exactly the friction adding a kind
 * should have.
 */
const PIPELINE_TAGS: Record<string, ModelShape> = {
    "text-generation": TEXT,
    "text2text-generation": TEXT,
    "image-text-to-text": { type: "generate", in: ["text", "image"], out: ["text"] },
    "audio-text-to-text": { type: "generate", in: ["text", "audio"], out: ["text"] },
    "text-to-speech": { type: "generate", in: ["text"], out: ["audio"] },
    "text-to-audio": { type: "generate", in: ["text"], out: ["audio"] },
    "text-to-image": { type: "transform", in: ["text"], out: ["image"] },
    "text-to-video": { type: "transform", in: ["text"], out: ["video"] },
    "automatic-speech-recognition": { type: "transform", in: ["audio"], out: ["text"] },
    "image-to-text": { type: "transform", in: ["image"], out: ["text"] },
    "feature-extraction": { type: "transform", in: ["text"], out: ["vector"] },
    "sentence-similarity": { type: "transform", in: ["text"], out: ["vector"] },
    "image-feature-extraction": { type: "transform", in: ["image"], out: ["vector"] },
    "depth-estimation": { type: "transform", in: ["image"], out: ["depth"] },
    "image-classification": { type: "transform", in: ["image"], out: ["text"] },
    "object-detection": { type: "transform", in: ["image"], out: ["text"] },
    "image-segmentation": { type: "transform", in: ["image"], out: ["image"] },
    "text-classification": { type: "transform", in: ["text"], out: ["text"] },
    "token-classification": { type: "transform", in: ["text"], out: ["text"] },
    "audio-classification": { type: "transform", in: ["audio"], out: ["text"] },
    "voice-activity-detection": { type: "stream", in: ["audio"], out: ["score"] },
}

/** Classify a Hugging Face model. Null when its task has no handle shape here. */
export function fromPipelineTag(tag: string | undefined): ModelShape | null {
    if (!tag) return null
    return PIPELINE_TAGS[tag] ?? null
}

/**
 * Ollama capability strings → shape.
 *
 * Ollama serves language models exclusively, so the type is never in
 * question; what varies is whether a model also accepts images. "chat" alone
 * is text-in/text-out, "vision" widens the input.
 */
export function fromOllamaCapabilities(capabilities: readonly string[] | undefined): ModelShape {
    const inputs: Modality[] = ["text"]
    if (capabilities?.includes("vision")) inputs.push("image")
    return { type: "generate", in: inputs, out: ["text"] }
}

/**
 * OpenRouter's `architecture.modality` string → shape.
 *
 * The upstream form is `"text+image->text"`: a `+`-joined input set, an
 * arrow, a `+`-joined output set. Already fetched today and used only as a
 * chat-capable filter before being discarded — this reads the same field for
 * what it actually says, which is why supporting vision roles needs no new
 * upstream data.
 *
 * Null on a shape this cannot parse. A malformed modality string is a model
 * we cannot classify, and the rule for those is the same everywhere here:
 * leave it out rather than guess.
 */
export function fromModalityString(modality: string | undefined): ModelShape | null {
    if (!modality) return null

    const [inputs, outputs] = modality.split("->")
    if (!inputs || !outputs) return null

    const parse = (side: string): Modality[] =>
        side
            .split("+")
            .map(value => value.trim())
            .filter((value): value is Modality =>
                value === "text" || value === "image" || value === "audio" || value === "video",
            )

    const isIn = parse(inputs)
    const isOut = parse(outputs)
    if (isIn.length === 0 || isOut.length === 0) return null

    return { type: "generate", in: isIn, out: isOut }
}

/**
 * OpenRouter-style modality arrays → shape.
 *
 * The richest source: the API publishes both sides per model, in a
 * vocabulary that already matches ours. Unknown members are dropped rather
 * than rejected — a new modality upstream should narrow what a model appears
 * able to do, never remove the model from the catalogue entirely.
 */
export function fromModalities(inputs: readonly string[] | undefined, outputs: readonly string[] | undefined): ModelShape {
    const known = (values: readonly string[] | undefined, fallback: Modality): Modality[] => {
        const mapped = (values ?? []).filter((value): value is Modality =>
            value === "text" || value === "image" || value === "audio" || value === "video",
        )
        return mapped.length > 0 ? mapped : [fallback]
    }

    return { type: "generate", in: known(inputs, "text"), out: known(outputs, "text") }
}
