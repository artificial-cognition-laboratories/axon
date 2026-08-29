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
 * both "more headroom for the same job". Then, last, the order the user
 * declared their providers in.
 *
 * ── Why declaration order is a tie-break and not a footnote ────────────────
 *
 * One canonical model is reachable through several routes: Claude Sonnet is
 * `axon` (metered), `openrouter` (BYOK), and `anthropic` (BYOK direct), and
 * the three capabilities are IDENTICAL on every axis above — same model, so
 * same context; all hosted, so none local; no slots ceiling unless the user
 * set one. Every comparison returns 0 and the winner is whichever the
 * gatherer happened to append first.
 *
 * That is not a cosmetic tie. Routes differ in who pays: binding a role to
 * `axon` when the user declared `Anthropic()` with their own key spends their
 * ledger instead of their key, decided by array order rather than by anything
 * anyone wrote down. So the pool's order — the user's own list, in the order
 * they wrote it — settles it. `providers: [Anthropic(), Axon()]` means what it
 * reads as: my key first, managed as the fallback.
 */
export function preference(order: ProviderOrder = EMPTY_ORDER) {
    return (a: EngineCapability, b: EngineCapability): number => {
        if (a.local !== b.local) return a.local ? -1 : 1
        if ((a.context ?? 0) !== (b.context ?? 0)) return (b.context ?? 0) - (a.context ?? 0)
        if ((a.slots ?? Infinity) !== (b.slots ?? Infinity)) return (b.slots ?? Infinity) - (a.slots ?? Infinity)
        return rank(order, a.provider) - rank(order, b.provider)
    }
}

/**
 * Provider names in the order the user declared them.
 *
 * A list rather than a map because it is exactly what the caller already has
 * — the pool — and asking for a precomputed index would make every call site
 * build one.
 */
export type ProviderOrder = readonly string[]

const EMPTY_ORDER: ProviderOrder = []

/**
 * Where a provider sits in the user's list.
 *
 * A name absent from the order sorts LAST rather than first. Absent means the
 * caller ranked without a pool (a test, a bare `resolveEngines` call), and
 * putting an unknown route ahead of a declared one would let a source the
 * user never mentioned win a tie against one they did.
 */
function rank(order: ProviderOrder, provider: string): number {
    const index = order.indexOf(provider)
    return index === -1 ? order.length : index
}
