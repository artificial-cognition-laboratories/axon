import type { CapsuleBlueprint, CapsulePartialConfig, CapsulePolicy } from "../types"

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
            ...partial.policy,
            process: { ...DEFAULT_PROCESS_POLICY, ...partial.policy?.process },
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
            process: { ...current.policy.process, ...partial.policy?.process },
        },
    })
}
