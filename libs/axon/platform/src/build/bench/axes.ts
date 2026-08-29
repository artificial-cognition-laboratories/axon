import type { BenchAxis, BenchAxisKey, BenchAxisVariation, BenchMatrix } from "@arcforge/types"

/**
 * Turn the authored `matrix` object into ordered axes.
 *
 * The authored form is deliberately terse — a key and a list of values, with
 * nothing to declare twice because the key IS the binding point. Everything
 * the manifest needs beyond that (stable ids, labels) is derived here, once,
 * at the seam.
 *
 * Ids come from the value itself rather than its position: `model[0]` would
 * mean a different thing the moment someone reorders the list, and cell ids
 * built from it would silently stop matching earlier runs of the same
 * benchmark. A label derived from the value stays stable under reordering.
 */
export function toAxes(matrix: BenchMatrix | undefined): BenchAxis[] {
    if (!matrix) return []

    return Object.entries(matrix)
        .filter(([, values]) => values !== undefined)
        .map(([key, values]) => ({
            key: key as BenchAxisKey,
            // A bare value is a held constant — `agent: "@axon/coding-base"`
            // says the same thing as a one-element array and reads like what it
            // means. It is still an axis: one cell, and the value still pinned
            // into the manifest, because a result is only comparable if what did
            // NOT vary is recorded too.
            values: withDistinctIds(Array.isArray(values) ? values : [values]),
        }))
}

/**
 * Derive ids, disambiguating any that collide.
 *
 * Two variations can legitimately share a derived label — `Mock()` twice with
 * different reply maps is the obvious case, since the engine name is the same
 * and the behaviour lives in a closure the id cannot see. Suffixing keeps the
 * readable part while staying unique, rather than rejecting a config that is
 * perfectly meaningful.
 */
function withDistinctIds(values: unknown[]): BenchAxisVariation[] {
    const variations = values.map(toVariation)
    const counts = new Map<string, number>()
    for (const variation of variations) counts.set(variation.id, (counts.get(variation.id) ?? 0) + 1)

    const seen = new Map<string, number>()
    return variations.map(variation => {
        if ((counts.get(variation.id) ?? 0) < 2) return variation
        const nth = (seen.get(variation.id) ?? 0) + 1
        seen.set(variation.id, nth)
        return { ...variation, id: `${variation.id}-${nth}`, label: `${variation.label} #${nth}` }
    })
}

/**
 * Derive a stable, readable id for one variation.
 *
 * An engine ref carries its model name, a path carries its directory — both
 * are what an author would call the variation anyway, so a run's cell ids
 * read as `model=claude-sonnet-4.6` rather than `model=0`.
 */
function toVariation(value: unknown, index: number): BenchAxisVariation {
    return { id: variationId(value, index), label: variationLabel(value), value }
}

function variationId(value: unknown, index: number): string {
    const label = variationLabel(value)
    if (!label) return String(index)
    // Cell ids end up in file paths and manifest keys, so keep them boring.
    return label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || String(index)
}

function variationLabel(value: unknown): string {
    if (typeof value === "string") return value
    if (value && typeof value === "object") {
        const record = value as Record<string, unknown>
        // EngineRef and friends: the model name is the identity an author means.
        for (const field of ["model", "id", "name", "ref"]) {
            const candidate = record[field]
            if (typeof candidate === "string" && candidate.length > 0) return candidate
        }
    }
    return typeof value === "number" || typeof value === "boolean" ? String(value) : ""
}
