import type {
    EngineBinding,
    EngineCapability,
    EngineRequirements,
    EngineResolution,
    EngineUnmet,
} from "@arcforge/types"
import { preference, reject } from "./match"
import { matchesPin, parsePin } from "./pin"

/**
 * Concurrency granted to a role the cognet did not fan out.
 *
 * One, always: a cognet that never declared `parallel` issues one call at a
 * time, and reporting more would advertise headroom nothing asked for.
 */
const SEQUENTIAL = 1

/**
 * Concurrency for a fanned-out role whose binding does not report a limit.
 *
 * A hosted route has no meaningful ceiling this side of a rate limit, so the
 * honest answer is "as many as you like". Chosen rather than Infinity because
 * this number is rendered in a UI and handed to a cognet deciding a batch
 * size — a brain that read Infinity would have to special-case it, and every
 * one of them would do it differently.
 */
const UNBOUNDED_SLOTS = 8

/**
 * Match what a cognet needs against what a user has.
 *
 * PURE. No network, no filesystem, no clock — the caller gathers catalogues
 * and this decides. That is what makes the same function answer for `axon
 * prepare` (does this machine run this agent?), for boot (bind the handles),
 * and for a test (does this design express the case?) without three
 * implementations drifting apart.
 *
 * TOTAL — never throws. A missing OPTIONAL role is ordinary and the brain
 * degrades around it; a missing required one stops prepare. A resolver that
 * threw on the first unfilled role could not express the difference, and the
 * caller is the only thing that knows which severity applies.
 *
 * Roles are resolved INDEPENDENTLY: one capability may fill several roles.
 * Doing otherwise would make a user with one good local model unable to run a
 * cognet that names three roles, which is exactly the user this exists to
 * serve — the same model answering as cortex and as compressor is slower, not
 * broken.
 */
export function resolveEngines(
    requirements: EngineRequirements,
    catalogue: readonly EngineCapability[],
    opts: { model?: string } = {},
): EngineResolution {
    // The user's cortex choice, applied to the PRIMARY role only. Parsed once
    // rather than per candidate — a pin is one string and re-parsing it 400
    // times to answer 400 comparisons would be work nobody asked for.
    const pin = parsePin(opts.model)
    const pinned = primaryRole(requirements)

    const bound: EngineBinding[] = []
    const unmet: EngineUnmet[] = []
    let unhonoured: EngineResolution["unhonoured"]

    for (const [role, requirement] of Object.entries(requirements)) {
        const reasons: string[] = []
        const candidates: EngineCapability[] = []

        for (const capability of catalogue) {
            const why = reject(requirement, capability)
            if (why) reasons.push(why)
            else candidates.push(capability)
        }

        // A pin PREFERS, never requires: it reorders candidates that already
        // satisfy the role, and a pin naming something this user cannot supply
        // (or that fails the role's own constraints) falls through to ranking
        // rather than failing the boot. That is what keeps a published agent
        // runnable by someone who does not share its author's providers.
        const ranked = candidates.sort(preference)
        const preferred = pin && role === pinned
            ? ranked.find(candidate => matchesPin(pin, candidate))
            : undefined

        // A pin that named something the pool cannot supply is recorded, not
        // swallowed. Distinguishing "wrong provider" from "wrong model" is
        // what makes the message actionable: one means connect a provider,
        // the other means the id is wrong.
        if (pin && role === pinned && !preferred) {
            const sameModel = catalogue.some(candidate => candidate.id === pin.model)
            unhonoured = {
                pin: opts.model ?? pin.model,
                reason: pin.provider !== undefined && sameModel
                    ? `no "${pin.provider}" provider is declared — the model exists on another route`
                    : pin.provider !== undefined
                        ? `no "${pin.provider}" provider is declared, and no candidate matches "${pin.model}"`
                        : `no declared provider supplies "${pin.model}"`,
            }
        }

        const best = preferred ?? ranked[0]
        if (!best) {
            unmet.push({ role, requirement, reasons })
            continue
        }

        bound.push({
            role,
            requirement,
            capability: best,
            slots: requirement.parallel ? (best.slots ?? UNBOUNDED_SLOTS) : SEQUENTIAL,
        })
    }

    return {
        bound,
        unmet,
        missing: unmet.filter(entry => entry.requirement.optional !== true),
        ...(unhonoured ? { unhonoured } : {}),
    }
}

/**
 * The role the model picker edits.
 *
 * `primary: true` when a cognet declares one. Falls back to a role literally
 * named "main" so a cognet that never thought about it still has a sensible
 * answer, and null when neither exists — a cognet with no generate role at
 * all (a pure control loop) genuinely has no model to pick, and inventing one
 * would put a dead entry in the UI.
 */
export function primaryRole(requirements: EngineRequirements): string | null {
    const declared = Object.entries(requirements).find(([, req]) => req.primary === true)
    if (declared) return declared[0]
    if (requirements.main) return "main"
    return null
}
