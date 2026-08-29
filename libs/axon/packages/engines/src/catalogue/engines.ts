import type {
    AxonDriver,
    EngineBinding,
    EngineCapability,
    EngineRequirements,
    EngineResolution,
} from "@arcforge/types"
import { resolveEngines, primaryRole, preference } from "../resolver"
import { matchesPin, parsePin } from "../resolver/pin"
import { EngineFailure } from "../shared"
import type { AxonProvider } from "./provider"

type EnginesOpts = {
    requirements: EngineRequirements
    /** Everything the user's providers can supply — already gathered. */
    capabilities: readonly EngineCapability[]
    /**
     * Providers by name, for building a driver once a role is bound.
     *
     * ITERATION ORDER IS LOAD-BEARING: it is the order the user declared
     * their providers in, and it settles which route wins when one model is
     * reachable through several. A Map preserves insertion order, so the
     * pool must be built in declaration order — see `preference()`.
     */
    providers: ReadonlyMap<string, AxonProvider>
    /**
     * The user's cortex choice — `"codex:gpt-5.6-terra"` or `"gpt-5.6-terra"`.
     *
     * Applied to the primary role as a preference. Absent means rank normally.
     */
    model?: string
}

/** One bound role, live: the binding plus the driver serving it. */
type Live = {
    binding: EngineBinding
    driver: AxonDriver
}

/**
 * The runtime's inference manager — every role a cognet declared, bound to
 * something the user actually has.
 *
 * A MANAGER, not a map, for one reason: the primary role is rebindable while
 * the agent runs (a user picks a different model), and callers must never
 * hold the inner driver directly or that swap would strand them. Roles
 * dispatch through `current`, exactly as Backend/AxonCapsule/AxonSession
 * already do — one idea, implemented consistently.
 *
 * Resolution happens ONCE, here, at construction. `get()` is a lookup that
 * cannot fail differently on the second tick than the first, and cannot
 * block: everything expensive — reaching a provider, loading local weights —
 * already happened before the cognet's first wake.
 */
export function Engines(opts: EnginesOpts) {
    const order = [...opts.providers.keys()]
    const rank = preference(order)
    const resolution = resolveEngines(opts.requirements, opts.capabilities, {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        order,
    })
    const live = new Map<string, Live>()

    /**
     * Candidates that survived a role's predicates, best first.
     *
     * Kept rather than discarded because a binding can fail at USE — a
     * provider that answered its catalogue honestly can still refuse the
     * call. Since a role is a predicate rather than an id, the next
     * candidate is already known to satisfy it, so recovery is a local swap
     * instead of a re-resolve against the whole pool.
     */
    const alternates = new Map<string, EngineCapability[]>()

    /**
     * Point a role at a different model.
     *
     * New driver constructed BEFORE the old reference is dropped, so a caller
     * mid-dispatch never sees a gap — the same overlap-not-gap rule
     * Backend.update() follows. The capability must already be in the gathered
     * pool: rebinding chooses among what the user has, it never reaches for
     * something they did not declare.
     *
     * A named function rather than only a method so `select()` can call it
     * without `this` — the handle is destructured by callers, and a `this`
     * reference would break the moment someone wrote `const { select } = ...`.
     */
    function rebindRole(role: string, capability: EngineCapability): void {
        const entry = live.get(role)
        if (!entry) {
            throw new EngineFailure({
                code: "INVALID_REQUEST",
                message: `ENGINE_ROLE_UNBOUND: cannot rebind "${role}" — it was never bound`,
                retryable: false,
                provider: "unbound",
            })
        }

        const driver = build(capability)
        live.set(role, { binding: { ...entry.binding, capability }, driver })
    }

    function build(capability: EngineCapability): AxonDriver {
        const provider = opts.providers.get(capability.provider)
        if (!provider) {
            throw new EngineFailure({
                code: "INVALID_REQUEST",
                message: `ENGINE_PROVIDER_MISSING: ${capability.provider} supplied ${capability.id} but is not in the pool`,
                retryable: false,
                provider: capability.provider,
                model: capability.id,
            })
        }
        return provider.create(capability)
    }

    for (const binding of resolution.bound) {
        live.set(binding.role, { binding, driver: build(binding.capability) })

        // Ranked the same way resolution ranked, not left in catalogue
        // order: these are what a picker offers and what a failed binding
        // falls back to, so "best first" has to mean the same thing here as
        // it did when the winner was chosen.
        const others = opts.capabilities
            .filter(candidate => candidate.id !== binding.capability.id && candidate.type === binding.requirement.type)
            .sort(rank)
        alternates.set(binding.role, others)
    }

    return {
        /** What resolution decided — bound roles, unmet ones, and what is fatally missing. */
        get resolution(): EngineResolution {
            return resolution
        },

        /**
         * Is this role filled? The cognet's whole degradation vocabulary.
         *
         * A role the cognet never declared answers false rather than
         * throwing: asking about an engine you did not ask for is a question,
         * not an error.
         */
        has(role: string): boolean {
            return live.has(role)
        },

        /**
         * The driver serving a role, and what it turned out to be.
         *
         * Throws for an unfilled role. Deliberately loud: a required role
         * that is missing already stopped prepare, so reaching here means the
         * cognet called an OPTIONAL engine without checking `has()` — a
         * cognet bug, and returning a null driver would push the same crash
         * one frame later with less information.
         */
        get(role: string): { driver: AxonDriver; binding: EngineBinding } {
            const entry = live.get(role)
            if (!entry) {
                throw new EngineFailure({
                    code: "INVALID_REQUEST",
                    message: `ENGINE_ROLE_UNBOUND: no engine bound to "${role}" — declare it in engines:, and check kernel.engine.has() before using an optional role`,
                    retryable: false,
                    provider: "unbound",
                })
            }
            return { driver: entry.driver, binding: entry.binding }
        },

        /**
         * Point a role at a different model.
         *
         * New driver constructed BEFORE the old reference is dropped, so a
         * caller mid-dispatch never sees a gap — the same overlap-not-gap
         * rule Backend.update() follows. The capability must already be in
         * the gathered pool: rebinding chooses among what the user has, it
         * never reaches for something they did not declare.
         */
        rebind: rebindRole,

        /**
         * Other capabilities that satisfy this role, best first.
         *
         * What a model picker offers for the primary role, and what a
         * failure path walks when a binding refuses at use.
         */
        alternates(role: string): readonly EngineCapability[] {
            return alternates.get(role) ?? []
        },

        /**
         * The role a model picker edits — the cognet's primary generate role.
         *
         * Null for a cognet that declares none, which is a real case (a pure
         * control loop has no model to pick) and must not be invented.
         */
        get primary(): string | null {
            return primaryRole(opts.requirements)
        },

        /**
         * Point the primary role at the model a user just picked.
         *
         * ── Why this lives here and not in the caller ───────────────────────
         *
         * `rebind()` takes a CAPABILITY; a picker has a STRING
         * (`"codex:gpt-5.6-terra"`). Nothing bridged the two, so the model
         * picker had no way to reach `rebind()` at all — it wrote the choice to
         * the agent's config and relied on a hot reload to apply it. A reload
         * deliberately does NOT re-resolve inference (a user's providers are
         * not something an agent's own config can change — see
         * `Engine.update()`), so the binding never moved and the new model only
         * took effect after a full reboot.
         *
         * Resolution belongs beside the pin grammar and the gathered pool, not
         * in a UI composable: `"ollama:qwen3:8b"` parses one way, ids are
         * matched exactly, and a caller reimplementing that would drift from
         * how the SAME string is honoured at boot.
         *
         * Returns what it bound so the caller can render it, or null when the
         * pin names nothing this user has. Null rather than throwing: a pin
         * PREFERS and never requires (see `resolveEngines`), so a model the
         * pool cannot supply is a choice that could not be honoured, not an
         * error — exactly the reading boot already takes via `unhonoured`.
         */
        select(model: string): EngineCapability | null {
            const role = primaryRole(opts.requirements)
            if (!role || !live.has(role)) return null

            const pin = parsePin(model)
            if (!pin) return null

            // The gathered pool only — the same rule `rebind()` enforces:
            // choosing among what the user declared, never reaching for
            // something they did not.
            const match = opts.capabilities.find(candidate => matchesPin(pin, candidate))
            if (!match) return null

            // Already serving this role — nothing to do, and rebuilding the
            // driver would drop a warm connection for no change.
            if (live.get(role)!.binding.capability.id === match.id
                && live.get(role)!.binding.capability.provider === match.provider) {
                return match
            }

            rebindRole(role, match)
            return match
        },
    }
}

export type EnginesT = ReturnType<typeof Engines>
