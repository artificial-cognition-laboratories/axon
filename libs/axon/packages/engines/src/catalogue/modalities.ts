import { shapeOfPipelineTag, type EngineType, type Modality, type ModelShape } from "@arcforge/types"

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
export type { ModelShape } from "@arcforge/types"

/** Kept under its catalogue name; the table itself is owned by @arcforge/types. */
export function fromPipelineTag(tag: string | undefined): ModelShape | null {
    return shapeOfPipelineTag(tag)
}

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
