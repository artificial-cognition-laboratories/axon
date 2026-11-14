import { err } from "@arcforge/err"

/**
 * One coherent ONNX set out of a repository — plain functions, no I/O.
 *
 * An ONNX repository ships the same graph many times: fp32, fp16, q4, int8…
 * each `name_<variant>.onnx` with its own weight data. A runtime loads ONE of
 * them, so a set is the chosen variant's graphs, their `.onnx_data`, and the
 * root configs — never the whole repository. Fetching everything cost ~1GB
 * of quantisations for a 150MB model nobody would load.
 *
 * Lives with the model toolchain because both halves need it: acquisition
 * (what to download) and the runtime (which dtype to load it as). One copy,
 * so what is downloaded and what is loaded cannot disagree.
 */

const DTYPES = { quantized: "q8", q4f16: "q4f16", q2f16: "q2f16", q1f16: "q1f16", bnb4: "bnb4", int8: "int8", uint8: "uint8", fp16: "fp16", q4: "q4", q2: "q2", q1: "q1" } as const
/** Longest first, so `q4f16` is not read as `q4`. */
const QUANTISATIONS = Object.keys(DTYPES).sort((a, b) => b.length - a.length)

export const onnx = {
    /**
     * The files of one variant — `variant` if the repository has it, else the
     * unquantised one, else the first by name. Null when there is no ONNX.
     */
    plan(names: string[], variant = ""): { files: string[]; primary: string } | null {
        const weights = names.filter(name => name.toLowerCase().endsWith(".onnx"))
        if (weights.length === 0) return null

        const grouped = new Map<string, string[]>()
        for (const name of weights) {
            const key = onnx.variant(name)
            grouped.set(key, [...(grouped.get(key) ?? []), name])
        }

        const chosen = grouped.get(variant)
            ?? grouped.get("")
            ?? [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))[0]?.[1]
        if (!chosen || chosen.length === 0) return null

        const data = names.filter(name => name.toLowerCase().endsWith(".onnx_data")
            && chosen.some(weight => name.startsWith(weight)))

        const merged = chosen.some(name => /_merged/i.test(name))
        const kept = merged
            ? chosen.filter(name => !/_with_past_model/i.test(name) && !/decoder_model(?!_merged)/i.test(name))
            : chosen

        return { files: [...names.filter(isConfig), ...kept, ...data], primary: primaryOf(kept) }
    },

    /** Which quantisation a graph file is — `""` for unquantised. */
    variant(name: string): string {
        const stem = name.slice(0, -".onnx".length)
        return QUANTISATIONS.find(suffix => stem.toLowerCase().endsWith(`_${suffix}`)) ?? ""
    },

    /** The dtype a runtime loads a set as. Refuses a directory holding more than one variant. */
    dtype(names: string[]): string {
        const variants = new Set(names.filter(name => name.endsWith(".onnx")).map(onnx.variant))
        if (variants.size !== 1) throw err("MODEL_LOAD_FAILED", { detail: "ONNX repository must contain one coherent quantization" })
        const variant = [...variants][0]
        if (variant === "") return "fp32"
        if (variant !== undefined && variant in DTYPES) return DTYPES[variant as keyof typeof DTYPES]
        throw err("MODEL_LOAD_FAILED", { detail: `unsupported ONNX quantization: ${variant}` })
    },
}

function primaryOf(weights: string[]): string {
    const sorted = [...weights].sort()
    return sorted.find(name => /_merged/i.test(name))
        ?? sorted.find(name => /(^|\/)model[^/]*\.onnx$/i.test(name))
        ?? sorted.find(name => /decoder/i.test(name))
        ?? sorted[0]!
}

/** A root-level config a runtime reads beside the graph — tokeniser, preprocessor, model config. */
function isConfig(name: string): boolean {
    if (name.includes("/")) return false
    if (/^readme|^\.git|^license/i.test(name)) return false
    return /\.(json|txt|model)$/i.test(name)
}
