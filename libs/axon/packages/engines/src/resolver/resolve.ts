import type {
    EngineBinding,
    EngineCapability,
    EngineRequirements,
    EngineResolution,
    EngineUnmet,
} from "@arcforge/types"
import { preference, reject, type ProviderOrder } from "./match"
import { matchesPin, parsePin } from "./pin"

/** How many preferred modalities one candidate supplies. Admission never reads this. */
function preferredCoverage(requirement: EngineRequirements[string], capability: EngineCapability): number {
    const preferred = requirement.prefer
    if (!preferred) return 0
    const list = <T>(value: T | T[] | undefined): T[] =>
        value === undefined ? [] : Array.isArray(value) ? value : [value]
    return list(preferred.in).filter(modality => capability.in.includes(modality)).length
        + list(preferred.out).filter(modality => capability.out.includes(modality)).length
}

/** Where a candidate's model sits in the list the role names — first is best. 0 for every candidate of a role that names none. */
function listed(requirement: EngineRequirements[string], capability: EngineCapability): number {
    return requirement.model ? requirement.model.indexOf(capability.id) : 0
}

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
 * `opts.order` is the user's provider list, in the order they declared it.
 * It settles ties between routes to the SAME model — which is the tie that
 * decides who pays, so it is not left to array order. See `preference()`.
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
    opts: {
        model?: string
        order?: ProviderOrder
        /**
         * Roles the agent granted a provider by name — `services:` in its
         * config. Unlike `model`, a grant is not a preference: the role binds
         * what it names or nothing, and a grant nothing supplies is missing
         * even on an optional role. The user said exactly what to use.
         */
        granted?: Readonly<Record<string, string>>
    } = {},
): EngineResolution {
    // The user's cortex choice, applied to the PRIMARY role only. Parsed once
    // rather than per candidate — a pin is one string and re-parsing it 400
    // times to answer 400 comparisons would be work nobody asked for.
    const pin = parsePin(opts.model)
    const pinned = primaryRole(requirements)

    // Built once rather than per role: the order is one array and closing
    // over it 400 times to answer 400 comparisons would be work nobody asked
    // for — the same reason the pin is parsed once above.
    const rank = preference(opts.order ?? [])

    const bound: EngineBinding[] = []
    const unmet: EngineUnmet[] = []
    let unhonoured: EngineResolution["unhonoured"]

    const grants = Object.fromEntries(Object.entries(opts.granted ?? {}).map(([role, named]) => [role, { named: named, pin: parsePin(named) }]))
    const forced: string[] = []

    for (const [role, requirement] of Object.entries(requirements)) {
        const reasons: string[] = []
        const candidates: EngineCapability[] = []
        const grant = grants[role]

        if (grant) {
            const offered = grant.pin ? catalogue.filter(capability => matchesPin(grant.pin!, capability)) : []
            const fits = offered.filter(capability => reject(requirement, capability, true) === null)
            if (fits.length === 0) {
                forced.push(role)
                unmet.push({ role, requirement, reasons: [offered.length === 0 ? `granted "${grant.named}", which no declared provider supplies` : `granted "${grant.named}", which cannot serve it: ${reject(requirement, offered[0]!, true)}`] })
                continue
            }
            bound.push({ role, requirement, capability: fits.sort(rank)[0]!, slots: requirement.parallel ? (fits[0]!.slots ?? UNBOUNDED_SLOTS) : SEQUENTIAL })
            continue
        }

        // The models a cognet names narrow the field before anything is
        // ranked, and order it after. The user's own pick for the primary
        // still reaches past them: the cognet chose a default, the user
        // chose this.
        const named = requirement.model
        let offered = false
        for (const capability of catalogue) {
            const explicit = pin !== null && role === pinned && matchesPin(pin, capability)
            if (named && !explicit && !named.includes(capability.id)) continue
            offered = true
            const why = reject(requirement, capability, explicit)
            if (why) reasons.push(why)
            else candidates.push(capability)
        }
        if (named && !offered) reasons.push(`names ${named.join(", ")}, which no declared provider supplies`)

        // An explicit choice overrides context/structured recommendations, while
        // input/output compatibility remains mandatory. A pin prefers candidates
        // rather than requiring them: unavailable or incompatible choices
        // fall through to ordinary ranking
        // rather than failing the boot. That is what keeps a published agent
        // runnable by someone who does not share its author's providers.
        // Preferred modalities rank only among otherwise admissible candidates.
        // They never turn a missing enhancement into an unmet role.
        const ranked = candidates.sort((a, b) =>
            listed(requirement, a) - listed(requirement, b)
            || preferredCoverage(requirement, b) - preferredCoverage(requirement, a)
            || rank(a, b),
        )
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
        missing: unmet.filter(entry => entry.requirement.optional !== true || forced.includes(entry.role)),
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
