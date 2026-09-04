import type { ModelFit, ModelRecord } from "./types"

/**
 * Whether a weight fits, and how a list of them should be ordered.
 *
 * ── Fit before popularity ───────────────────────────────────────────────────
 *
 * A registry page ranks by stars because everything on it is usable. A local
 * model browser cannot: the list is shared between an 11GB laptop and a
 * 200GB server, and the same row is excellent on one and impossible on the
 * other. Ordering by downloads alone put a 1.4TB model at the top of a
 * machine that could never load it, which is worse than no ordering — it
 * actively misinforms about what the machine can do.
 */

/** Bytes per parameter at half precision, which is how most weights ship. */
const BYTES_PER_PARAM = 2

/**
 * A parameter count out of a model's name — `Qwen3-8B`, `llama3.2:3b`.
 *
 * A heuristic, and labelled as one. Hugging Face listings publish no size at
 * all, so without this almost every row would be "unknown" and the fit filter
 * would have nothing to work with. Carried in `estimatedBytes` rather than
 * `bytes` so a guess is never mistaken for a measurement.
 */
export function estimateBytes(name: string): number | null {
    const match = /(\d+(?:\.\d+)?)\s*([bm])(?![a-z0-9])/i.exec(name)
    if (!match) return null

    const value = Number(match[1])
    if (!Number.isFinite(value) || value <= 0) return null

    const scale = match[2]!.toLowerCase() === "b" ? 1e9 : 1e6
    return Math.round(value * scale * BYTES_PER_PARAM)
}

/**
 * How a weight sits against the ceiling in force.
 *
 * "tight" is its own answer rather than a shade of "fits": a model needing
 * most of the card will load and then leave nothing for anything else, which
 * a person choosing between two models wants to know before they download
 * four gigabytes.
 */
export function fitFor(bytes: number | null, ceiling: number | null): ModelFit {
    // A size of zero is UNKNOWN, never a zero-byte model. Ollama's library
    // reports 0 for entries whose size it does not publish, and treating that
    // as a measurement put frontier-scale models at the top of the list marked
    // as comfortably fitting — the same "null is not zero" rule the machine
    // domain keeps about video memory, in a second place that needed it.
    if (bytes === null || bytes <= 0 || ceiling === null || ceiling <= 0) return "unknown"
    if (bytes > ceiling) return "over"
    return bytes > ceiling * 0.8 ? "tight" : "fits"
}

/** Fit, ranked. Higher is better; "unknown" sits between usable and impossible. */
const FIT_RANK: Record<ModelFit, number> = { fits: 3, tight: 2, unknown: 1, over: 0 }

/**
 * The composite ordering.
 *
 * Fit dominates, then whether anything here can execute it, then popularity —
 * log-scaled, because raw downloads is a verdict rather than a signal. A
 * weight with 255 million downloads would otherwise outrank every other
 * consideration permanently, and the top of the list would never change.
 */
export function score(model: ModelRecord): number {
    const fit = FIT_RANK[model.fit] * 1000
    const runnable = model.runtime ? 200 : 0
    const cached = model.cached ? 400 : 0
    const popularity = model.downloads && model.downloads > 0 ? Math.log10(model.downloads) * 10 : 0
    const liked = model.likes && model.likes > 0 ? Math.log10(model.likes) * 5 : 0
    return fit + cached + runnable + popularity + liked
}

/** How a caller asked for the list to be ordered. */
export type ModelSort = "relevance" | "downloads" | "size" | "recent"

export function order(models: ModelRecord[], sort: ModelSort = "relevance"): ModelRecord[] {
    const sorted = [...models]

    switch (sort) {
    case "downloads":
        return sorted.sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0))
    case "size":
        // Smallest first, and unknown last: someone sorting by size is looking
        // for something that will fit, and a row with no size answers nothing.
        return sorted.sort((a, b) => {
            const left = a.bytes ?? a.estimatedBytes
            const right = b.bytes ?? b.estimatedBytes
            if (left === null && right === null) return 0
            if (left === null) return 1
            if (right === null) return -1
            return left - right
        })
    case "recent":
        return sorted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    default:
        return sorted.sort((a, b) => score(b) - score(a))
    }
}
