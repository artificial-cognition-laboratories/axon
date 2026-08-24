import type { EngineCapability, EngineRequirement, Modality } from "@arcforge/types"

/** A requirement's `in`/`out` accept a bare value; every matcher wants the list. */
export function modalities(value: Modality | Modality[]): Modality[] {
    return Array.isArray(value) ? value : [value]
}

/**
 * Why one candidate was rejected, or null when it fits.
 *
 * Returns the REASON rather than a boolean so `axon prepare` can tell a user
 * "your models fit everything except the 100k context" instead of
 * "unresolved" — a near miss the user can act on is the difference between
 * this system being usable offline and being a wall.
 */
export function reject(req: EngineRequirement, cap: EngineCapability): string | null {
    if (cap.type !== req.type) {
        return `${cap.id}: is ${cap.type}, needs ${req.type}`
    }

    // Inputs are a REQUIREMENT on the candidate: everything the cognet will
    // send has to be understood. Sending an image to a text-only model is not
    // slow, it is impossible.
    const wantIn = modalities(req.in)
    const missingIn = wantIn.filter(m => !cap.in.includes(m))
    if (missingIn.length > 0) {
        return `${cap.id}: cannot accept ${missingIn.join(", ")}`
    }

    const wantOut = modalities(req.out)
    const missingOut = wantOut.filter(m => !cap.out.includes(m))
    if (missingOut.length > 0) {
        return `${cap.id}: cannot produce ${missingOut.join(", ")}`
    }

    // Absent context is UNKNOWN, not zero. A source that does not report a
    // window (a codex-only id) must not be silently excluded from every role
    // that names one — that would quietly delete half the catalogue.
    if (req.context !== undefined && cap.context !== undefined && cap.context < req.context) {
        return `${cap.id}: context ${cap.context} < ${req.context}`
    }

    // Structured output is the one capability where absent means NO. A model
    // that cannot be relied on to emit parseable blocks breaks the grammar,
    // and guessing optimistically here fails at the first tick instead of at
    // prepare.
    if (req.structured === true && cap.structured !== true) {
        return `${cap.id}: no structured output`
    }

    return null
}

/**
 * Preference order among candidates that all satisfy a requirement.
 *
 * Ranking, never admission — a wrong answer here costs a suboptimal pick,
 * not a failed install, which is the property that lets this stay a rough
 * heuristic while model measurement is still immature.
 *
 * Local first, deliberately: a user who has put a model on their own machine
 * has already expressed the preference, and it is the choice that keeps an
 * agent working with the network off. Then wider context, then more slots —
 * both "more headroom for the same job".
 */
export function preference(a: EngineCapability, b: EngineCapability): number {
    if (a.local !== b.local) return a.local ? -1 : 1
    if ((a.context ?? 0) !== (b.context ?? 0)) return (b.context ?? 0) - (a.context ?? 0)
    return (b.slots ?? Infinity) - (a.slots ?? Infinity)
}
