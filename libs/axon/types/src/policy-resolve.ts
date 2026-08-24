import type { CapsulePolicy, PolicyRule, PolicyVerdictSource } from "./policy"

/**
 * Resolving two policy layers into one verdict — the ceiling model.
 *
 * A PROFILE policy bounds every agent on the machine; an AGENT policy narrows
 * within it. "No internet, no shell" set once at the profile is then true of
 * every agent, and an agent can only ever tighten — which is the property that
 * makes a profile worth setting at all.
 *
 * Lives here, in types, because three consumers must resolve identically: the
 * kernel (enforcement), the CLI (`axon policy`), and Fleet (the policy view).
 * A second implementation would drift on exactly the cases that matter.
 *
 * ── Verdicts intersect; globs do NOT merge ──────────────────────────────────
 *
 * Each layer is evaluated INDEPENDENTLY against the subject, then the stricter
 * verdict wins. Merging the rule objects would be wrong in a way that quietly
 * grants capability: profile `allow: ["git *"]` unioned with agent
 * `allow: ["git push*"]` produces a rule permitting both, when the profile
 * never permitted `git push` on its own. Evaluating separately makes widening
 * impossible by construction rather than by careful glob authorship.
 *
 * ── Silence is "no opinion", not "deny" ─────────────────────────────────────
 *
 * The mediator's own default is deny-by-omission — correct for a sandbox
 * holding foreign code. This is the opposite: a profile that declares one tool
 * rule must not thereby deny every other tool on the machine, or adding a
 * single line to a profile would break every agent on it. So an undeclared
 * capability falls through to the other layer, and only DECLARED rules
 * intersect.
 *
 * The two defaults sit inches apart and mean opposite things. That is
 * deliberate, and it is the thing to re-read before changing either.
 */

/** How strict a verdict is. Higher wins when two layers disagree. */
const RANK = { allow: 0, escalate: 1, deny: 2 } as const

export type PolicyVerdict = "allow" | "deny" | "escalate"

/** A verdict plus what produced it, for a surface that has to explain itself. */
export type ResolvedVerdict = {
    verdict: PolicyVerdict
    /** Absent when no layer declared a rule — the caller applies its own default. */
    source?: PolicyVerdictSource
}

/**
 * Minimal glob matcher — `*` (any chars, no `/`), `**` (any chars including
 * `/`), everything else literal.
 *
 * Duplicated from the capsule's own matcher on purpose: this package must not
 * import from a runtime package (it is the contract every one of them depends
 * on), and policy globs are a handful of characters rather than a library. The
 * two are asserted equivalent by the resolver's tests — if either grows, that
 * is the moment to promote one into a shared leaf.
 */
export function policyGlobMatch(pattern: string, value: string): boolean {
    // Built by SCANNING rather than by chained replaces.
    //
    // The chained form used a space as its `**` placeholder and then rewrote
    // every space to `.*` — including the literal spaces the user typed. So
    // `allow: ["bun run *"]` compiled to `bun.*run.*[^/]*` and permitted
    // `bun-run-anything`: an allowlist granting far more than it named, which
    // is the exact failure a policy matcher must not have. Scanning has no
    // placeholder to collide with.
    let source = ""
    for (let i = 0; i < pattern.length; i++) {
        if (pattern[i] === "*") {
            if (pattern[i + 1] === "*") {
                source += ".*"
                i++
            } else {
                source += "[^/]*"
            }
            continue
        }
        // Everything else is literal, including spaces.
        source += pattern[i]!.replace(/[.+^${}()|[\]\\?*]/g, "\\$&")
    }
    return new RegExp(`^${source}$`).test(value)
}

/**
 * Evaluate ONE layer's rule against a subject.
 *
 * Returns undefined when the layer declared nothing — distinct from a rule
 * that declared something and matched nothing, which is a deny.
 *
 * Precedence inside a glob rule is deny → escalate → allow, matching the
 * capsule mediator exactly: the strictest matching clause wins regardless of
 * authoring order, so a user cannot accidentally out-order their own denial.
 */
export function evaluateRule(
    rule: PolicyRule | undefined,
    subject: string,
    layer: PolicyVerdictSource["layer"],
): ResolvedVerdict | undefined {
    if (rule === undefined) return undefined

    if (rule === true) return { verdict: "allow", source: { layer, subject, rule } }
    if (rule === false) return { verdict: "deny", source: { layer, subject, rule } }
    if (rule === "escalate") return { verdict: "escalate", source: { layer, subject, rule } }

    const denied = rule.deny?.find(pattern => policyGlobMatch(pattern, subject))
    if (denied !== undefined) return { verdict: "deny", source: { layer, subject, pattern: denied, rule } }

    const escalated = rule.escalate?.find(pattern => policyGlobMatch(pattern, subject))
    if (escalated !== undefined) return { verdict: "escalate", source: { layer, subject, pattern: escalated, rule } }

    const allowed = rule.allow?.find(pattern => policyGlobMatch(pattern, subject))
    if (allowed !== undefined) return { verdict: "allow", source: { layer, subject, pattern: allowed, rule } }

    // Declared, matched nothing. A glob rule is an allowlist: naming what is
    // permitted and hitting none of it is a denial, not silence.
    return { verdict: "deny", source: { layer, subject, rule } }
}

/**
 * The effective verdict for one subject under both layers.
 *
 * The stricter of the two wins, and the returned `source` is the layer that
 * PRODUCED that verdict — so a denial can always name who denied it. When both
 * agree, the profile is reported: it is the binding constraint, and telling a
 * user their agent denied something their profile also denies sends them to
 * the wrong file.
 */
export function resolveVerdict(
    profileRule: PolicyRule | undefined,
    agentRule: PolicyRule | undefined,
    subject: string,
): ResolvedVerdict {
    const profile = evaluateRule(profileRule, subject, "profile")
    const agent = evaluateRule(agentRule, subject, "agent")

    if (!profile && !agent) return { verdict: "allow" }
    if (!profile) return agent!
    if (!agent) return profile

    // Ties go to the profile — see above.
    return RANK[agent.verdict] > RANK[profile.verdict] ? agent : profile
}

/**
 * Isolation is a TIER, not a rule, so it intersects as a maximum rather than
 * through the verdict ranking: a profile asking for `hardened` cannot be
 * loosened to `none` by an agent, but an agent may harden beyond its profile.
 */
const ISOLATION_RANK = { none: 0, auto: 1, hardened: 2 } as const

export function resolveIsolation(
    profile: CapsulePolicy["isolation"],
    agent: CapsulePolicy["isolation"],
): CapsulePolicy["isolation"] | undefined {
    if (profile === undefined) return agent
    if (agent === undefined) return profile
    return ISOLATION_RANK[agent] > ISOLATION_RANK[profile] ? agent : profile
}
