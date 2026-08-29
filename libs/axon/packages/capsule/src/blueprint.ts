import type { CapsuleBlueprint, CapsulePartialConfig } from "../types"

/**
 * Normalizes a partial config into the strict CapsuleConfig shape everything
 * downstream trusts. Unlike AxonBlueprint(), nothing here is required — a
 * capsule with no input is a valid, safe capsule (host cwd, inherited env,
 * no tools, deny-by-default policy). This is the one seam where `?? default`
 * happens; nothing past it should ever re-check a config field for absence.
 */

/**
 * The wildcard key a bare bucket rule normalises to — see PolicyBucket.
 *
 * Re-exported, never re-declared: `@arcforge/types` owns the literal, because
 * Policy() there is the one seam that resolves a profile ceiling against an
 * agent's policy. A second copy here is how the keyed and blanket forms drift
 * apart silently — a blanket rule stops matching and every call it gated falls
 * through to deny-by-default, with nothing thrown to notice.
 */
import { keyed, POLICY_WILDCARD } from "@arcforge/types"
export { POLICY_WILDCARD }

export function Blueprint(input?: CapsulePartialConfig): CapsuleBlueprint {
    const partial = input ?? {}

    return {
        ...(partial.name !== undefined ? { name: partial.name } : {}),
        cwd: partial.cwd ?? process.cwd(),
        env: partial.env ?? {},
        tools: partial.tools ?? [],
        policy: {
            // The capsule primitive defaults to no OS wall — a bare Capsule()
            // is a valid mediator-only sandbox with no host dependencies, which
            // is what embedders and unit tests want. Axon's kernel opts into
            // isolation:"auto" in its own defaultPolicy(), the trust boundary
            // that actually wants the box.
            isolation: "none",
            /**
             * Normalisation is `keyed()` in @arcforge/types, and only there.
             *
             * This seam used to carry its own copy — `bucket()`, `isBareRule()`,
             * `processPolicy()` and a second POLICY_WILDCARD — because the
             * capsule was a subprocess that could not import across the
             * boundary. Two normalisers for one policy is how a bare rule
             * expands one way on the host and another in here, which is a
             * silent permission change rather than a visible bug.
             */
            ...keyed(partial.policy ?? {}),
        },
        ...(partial.escalate !== undefined ? { escalate: partial.escalate } : {}),
        ...(partial.host !== undefined ? { host: partial.host } : {}),
        ...(partial.boot !== undefined ? { boot: partial.boot } : {}),
        ...(partial.restart !== undefined ? { restart: partial.restart } : {}),
        ...(partial.spawn !== undefined ? { spawn: partial.spawn } : {}),
    }
}

/**
 * Overlays a partial onto the current config and re-normalizes through
 * CapsuleBlueprint(), so an updated config obeys the exact same contract as
 * a boot-time one. Mirrors mergeBlueprint() on the Axon side.
 */
export function mergeCapsuleConfig(current: CapsuleBlueprint, partial: CapsulePartialConfig): CapsuleBlueprint {
    /**
     * The current policy is RESOLVED and the incoming one is AUTHORED.
     *
     * They are different types on purpose — a resolved rule may be a carried
     * profile/agent pair, which nobody writes. Re-normalising a resolved policy
     * is not meaningful, so an update REPLACES each surface it names and keeps
     * the resolved value for the ones it does not.
     */
    const policy = {
        ...(current.policy as unknown as NonNullable<CapsulePartialConfig["policy"]>),
        ...partial.policy,
    }

    return Blueprint({
        ...current,
        ...partial,
        env: { ...current.env, ...partial.env },
        /**
         * Surfaces REPLACE rather than merge.
         *
         * `shell: false` has to mean the surface is off, and deep-merging it
         * into whatever was there before would leave the old `allow` list
         * standing beside the new denial. Blueprint() normalises the result, so
         * this only has to hand the authored shape through intact.
         */
        policy,
    })
}
