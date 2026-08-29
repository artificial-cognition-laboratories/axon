import type { AxonBlueprint } from "./blueprint"
import type { CapsulePolicy } from "./policy"
import { intersect, keyed, POLICY_WILDCARD, resolveFsPaths, type NormalizedPolicy, type ToolPolicyEntry } from "./policy-normalize"

/**
 * Policy — the ONE place a user's intent becomes a machine-enforceable policy.
 *
 * Resolution used to happen twice, in two packages: the kernel intersected the
 * profile ceiling with the agent's own policy, then the capsule's Blueprint()
 * normalised the result again at its own seam. Two normalisations meant two
 * wildcard literals kept in step by a test — see POLICY_WILDCARD. With the
 * agent boundary moving out to the whole process, both consumers now live
 * below this seam and there is exactly one resolution.
 *
 * ── The two outputs, and why they are not the same thing ────────────────────
 *
 * A resolved policy feeds two enforcement layers with DIFFERENT expressive
 * power, and conflating them is how a ceiling springs a leak:
 *
 *   confinement — the OS wall. Paths become bind mounts, network becomes a
 *                 namespace, limits become cgroup caps. It cannot express a
 *                 glob: `process: { allow: ["git *"] }` is not something a
 *                 mount namespace has any opinion about.
 *
 *   mediation   — the in-agent gate. Globs, per-host rules, per-command
 *                 patterns, escalation to a human. It runs INSIDE the box and
 *                 so can only ever narrow what the box already permits.
 *
 * The invariant between them: **the OS wall is the ceiling and mediation
 * narrows within it.** A mediator that allowed what the wall denies would
 * produce calls that pass policy and then fail as ENOENT — a confusing bug
 * class that is cheap to prevent here and expensive to diagnose later.
 */
export type ResolvedPolicy = {
    /**
     * What the capsule/agent enforces — the keyed, fully-normalised shape.
     * Every bare rule is expanded, every fs path is absolute.
     */
    policy: CapsulePolicy
    /** Which containment tier this policy asked for, after the ceiling applied. */
    isolation: NonNullable<CapsulePolicy["isolation"]>
}

/**
 * The capsule's own defaults are deny-by-default — correct for a sandbox that
 * must never silently grant an undeclared capability to arbitrary loaded code.
 * Axon is a different trust boundary: it is wiring up a box for its OWN
 * declared blueprint, not sandboxing foreign code, so its default posture is
 * the opposite — allow everything the blueprint's own policy doesn't restrict.
 *
 * Scoped to loadable tools: a rule naming a namespace that is never installed
 * grants nothing and only makes the policy surface read as larger than it is.
 */
type PolicyOpts = {
    blueprint: AxonBlueprint
    /** Tool namespaces actually installed — each gets an allow rule unless the policy says otherwise. */
    tools: string[]
}

export function Policy(opts: PolicyOpts): ResolvedPolicy {
    const { blueprint } = opts

    // The two layers, intersected into what the agent enforces.
    //
    // The profile is a CEILING: an agent narrows within it and can never widen
    // it. Resolved HERE rather than in the TUI, because this is the one seam
    // every consumer passes through — `axon dev`, `axon run` in a script, a
    // test harness. A ceiling applied only on the TUI's spawn path would be
    // advisory, and the CLI is exactly where someone scripting would bypass it
    // without meaning to.
    //
    // Both layers normalised to the KEYED shape before they meet: a bare
    // `tools: "escalate"` is an authoring convenience, and every rule below
    // reads one shape.
    const userPolicy: NormalizedPolicy = intersect(
        blueprint.profilePolicy ? keyed(blueprint.profilePolicy) : undefined,
        keyed(blueprint.config.policy ?? {}),
    )

    // The invariant: not setting a security policy means "I don't care" — the
    // agent gets full access to the machine, no hassle, no dependencies.
    // Setting ANY containment intent (fs/network/limits) opts into rootless
    // confinement, which needs no privilege and just works. A user can always
    // name isolation explicitly to force a tier ("hardened", or "none" despite
    // having fs).
    //
    // Read off the INTERSECTED policy, so a profile declaring containment opts
    // every agent on the machine into it — an agent that declares nothing still
    // gets the wall its profile asked for.
    const wantsContainment =
        userPolicy.fs !== undefined
        || userPolicy.net !== undefined
        || userPolicy.limits !== undefined
        || userPolicy.env !== undefined
    const isolation = userPolicy.isolation ?? (wantsContainment ? "auto" : "none")

    /**
     * Installed tools default to allowed — but ONLY where no layer has spoken.
     *
     * The default used to be written as `{ ...defaults, ...userPolicy.tools }`,
     * which looks like "the user's rules win" and is not. A profile blanket
     * normalises to the key `"*"`, so it never collides with a tool's own name:
     * the default `github: true` sat at key `github`, the address walk found it
     * before ever consulting `"*"`, and a profile declaring `tools: "escalate"`
     * silently granted every installed tool instead. That is precisely the leak
     * `pairRules` exists to prevent, reintroduced one layer above it.
     *
     * So a default is only applied to a name that the RESOLVED policy — after
     * the ceiling has run — says nothing about, wildcard included.
     */
    const resolvedTools = userPolicy.tools ?? {}
    const blanket = resolvedTools[POLICY_WILDCARD]
    const tools: Record<string, ToolPolicyEntry> = { ...resolvedTools }
    for (const name of opts.tools) {
        if (name in resolvedTools) continue
        if (blanket !== undefined) continue
        tools[name] = true
    }

    return {
        isolation,
        policy: {
            ...userPolicy,
            isolation,
            ...(userPolicy.fs ? { fs: resolveFsPaths(userPolicy.fs, blueprint.paths.root) } : {}),
            tools,
        } as CapsulePolicy,
    }
}
