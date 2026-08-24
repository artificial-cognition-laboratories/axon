import type { CapsuleBlueprint, CapsulePartialConfig, CapsulePolicy, PolicyBucket, PolicyRule } from "../types"

const DEFAULT_PROCESS_POLICY: CapsulePolicy["process"] = {
    spawn: false,
    run: false,
}

/**
 * Normalizes a partial config into the strict CapsuleConfig shape everything
 * downstream trusts. Unlike AxonBlueprint(), nothing here is required — a
 * capsule with no input is a valid, safe capsule (host cwd, inherited env,
 * no tools, deny-by-default policy). This is the one seam where `?? default`
 * happens; nothing past it should ever re-check a config field for absence.
 */

/** The wildcard key a bare bucket rule normalises to — see PolicyBucket. */
export const POLICY_WILDCARD = "*"

/**
 * One enforcement surface, as the capsule enforces it.
 *
 * A bare rule becomes a single wildcard entry, so the keyed and blanket forms
 * are the same shape downstream. `{ "*": rule }` also composes with named keys
 * for free: the mediator prefers an exact match and falls back to the
 * wildcard, which is ordinary glob precedence.
 */
function bucket(value: PolicyBucket): Record<string, PolicyRule> {
    return isBareRule(value) ? { [POLICY_WILDCARD]: value } : value
}

/**
 * `process`, which is a PAIR rather than an open bucket.
 *
 * Its two verbs are fixed and known, so a bare rule applies to both rather
 * than becoming a wildcard key — there is no third verb a wildcard could ever
 * match, and the strict type names them individually.
 */
function processPolicy(
    value: Partial<CapsulePolicy["process"]> | PolicyRule | undefined,
): CapsulePolicy["process"] {
    if (value === undefined) return { ...DEFAULT_PROCESS_POLICY }
    if (isBareRule(value)) return { spawn: value, run: value }
    return { ...DEFAULT_PROCESS_POLICY, ...value }
}

/** A rule with no keys of its own — `true`, `false`, `"escalate"`, or a glob object. */
function isBareRule(value: PolicyBucket | Partial<CapsulePolicy["process"]>): value is PolicyRule {
    if (typeof value === "boolean" || value === "escalate") return true
    // The glob object form. Distinguished from a keyed bucket by its OWN keys:
    // `allow`/`deny`/`escalate` are the rule's vocabulary, and a bucket keyed
    // by a module actually named "allow" is a collision nobody can author
    // (module names are scoped identifiers, not bare verbs).
    if (typeof value !== "object" || value === null) return false
    const keys = Object.keys(value)
    return keys.length > 0 && keys.every(key => key === "allow" || key === "deny" || key === "escalate")
}

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
            // Spread FIRST, then the normalised surfaces below overwrite the
            // authored ones — the raw partial still carries the bare forms,
            // which are not the shape the capsule enforces.
            ...partial.policy,
            tools: undefined,
            network: undefined,
            // A bare rule on a surface covers everything in it, now and later:
            // `tools: "escalate"` had to be written as one entry per installed
            // module, a list that is complete the day it is written and stale
            // the moment anything else is installed.
            //
            // Normalised HERE so the mediator never has to ask which shape it
            // was handed — it reads the keyed form on every call, and this is
            // the seam that already normalises everything else.
            ...(partial.policy?.tools !== undefined ? { tools: bucket(partial.policy.tools) } : {}),
            ...(partial.policy?.network !== undefined ? { network: bucket(partial.policy.network) } : {}),
            process: processPolicy(partial.policy?.process),
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
    return Blueprint({
        ...current,
        ...partial,
        env: { ...current.env, ...partial.env },
        policy: {
            ...current.policy,
            ...partial.policy,
            // A bare `process` rule REPLACES the pair rather than merging into
            // it: `process: false` means both verbs are denied, and spreading
            // a non-object would throw. Blueprint() normalises it below either
            // way, so this only has to hand it through intact.
            process: isBareRule(partial.policy?.process ?? {})
                ? partial.policy!.process
                : { ...current.policy.process, ...partial.policy?.process as Partial<CapsulePolicy["process"]> },
        },
    })
}
