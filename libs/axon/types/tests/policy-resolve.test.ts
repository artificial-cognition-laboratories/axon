import { describe, expect, test } from "bun:test"
import { evaluateRule, policyGlobMatch, resolveIsolation, resolveVerdict } from "../src/policy-resolve"
import { isRulePair } from "../src/policy"

/**
 * The ceiling: a profile bounds every agent, an agent can only narrow.
 *
 * These are the semantics the whole feature rests on, and the failure mode is
 * silent — a widening bug does not throw, it grants capability the user
 * believed they had removed. So the cases below are written as claims about
 * what a user is entitled to assume, not as coverage of the branches.
 */

describe("the profile is a ceiling", () => {
    test("an agent cannot widen a profile denial", () => {
        // The whole point. "No shell on this machine" must survive any agent
        // declaring otherwise.
        expect(resolveVerdict(false, true, "bun test").verdict).toBe("deny")
    })

    test("an agent cannot widen a profile escalation to a silent allow", () => {
        // The agent said "I'm fine with this"; the profile said "ask me".
        // Asking wins — an agent author must not be able to suppress the
        // machine owner's prompts.
        expect(resolveVerdict("escalate", true, "curl example.com").verdict).toBe("escalate")
    })

    test("an agent CAN narrow an allow", () => {
        // Narrowing is always permitted: that is the composability the model
        // exists for — machine-wide allow, one agent locked down further.
        expect(resolveVerdict(true, false, "rm -rf /").verdict).toBe("deny")
        expect(resolveVerdict(true, "escalate", "git push").verdict).toBe("escalate")
    })

    test("both allowing allows", () => {
        expect(resolveVerdict(true, true, "ls").verdict).toBe("allow")
    })
})

describe("silence is no opinion, never a denial", () => {
    test("an undeclared profile falls through to the agent", () => {
        // A profile declaring ONE tool rule must not thereby deny every other
        // capability on the machine — otherwise adding a line to a profile
        // breaks every agent on it.
        expect(resolveVerdict(undefined, true, "ls").verdict).toBe("allow")
        expect(resolveVerdict(undefined, false, "ls").verdict).toBe("deny")
    })

    test("an undeclared agent inherits the profile", () => {
        expect(resolveVerdict(false, undefined, "ls").verdict).toBe("deny")
        expect(resolveVerdict("escalate", undefined, "ls").verdict).toBe("escalate")
    })

    test("neither declaring anything defers to the caller's own default", () => {
        // Reported as allow with NO source: nothing decided this, so the
        // caller applies its own posture (the kernel allows installed tools by
        // default; the mediator denies by omission). A source here would claim
        // a decision nobody made.
        const resolved = resolveVerdict(undefined, undefined, "ls")
        expect(resolved.verdict).toBe("allow")
        expect(resolved.source).toBeUndefined()
    })
})

describe("globs are evaluated per layer, never merged", () => {
    test("a union of two allowlists does not grant either's gap", () => {
        // The bug this design exists to prevent: merging the rule objects
        // would produce `allow: ["git *", "git push*"]` and permit `git push`
        // under a profile that never permitted it on its own.
        const profile = { allow: ["git status"] }
        const agent = { allow: ["git push"] }

        // Neither subject is allowed by BOTH, so neither is allowed.
        expect(resolveVerdict(profile, agent, "git push").verdict).toBe("deny")
        expect(resolveVerdict(profile, agent, "git status").verdict).toBe("deny")
    })

    test("a profile deny beats an agent allow that matches more broadly", () => {
        // The landmine case: the user allowed ./data, the profile denied
        // secrets, and data/secrets/key is denied. Correct, and it must say
        // WHICH layer denied it or it reads as the agent's rule misbehaving.
        const resolved = resolveVerdict({ deny: ["**/secrets/**"] }, { allow: ["data/**"] }, "data/secrets/key")

        expect(resolved.verdict).toBe("deny")
        expect(resolved.source?.layer).toBe("profile")
        expect(resolved.source?.pattern).toBe("**/secrets/**")
    })

    test("a subject both layers allow is allowed", () => {
        expect(resolveVerdict({ allow: ["git *"] }, { allow: ["git *"] }, "git status").verdict).toBe("allow")
    })
})

describe("inside one rule, the strictest clause wins", () => {
    test("deny beats escalate beats allow regardless of authoring order", () => {
        // A user cannot accidentally out-order their own denial by listing
        // allow first — the mediator applies the same precedence, and the two
        // must not disagree.
        const rule = { allow: ["*"], escalate: ["git *"], deny: ["git push*"] }

        expect(evaluateRule(rule, "git push origin", "agent")?.verdict).toBe("deny")
        expect(evaluateRule(rule, "git status", "agent")?.verdict).toBe("escalate")
        expect(evaluateRule(rule, "ls", "agent")?.verdict).toBe("allow")
    })

    test("a glob rule matching nothing is a denial, not silence", () => {
        // An allowlist that names what is permitted has denied everything else
        // by saying so. Distinct from an ABSENT rule, which decided nothing.
        expect(evaluateRule({ allow: ["git *"] }, "rm -rf", "agent")?.verdict).toBe("deny")
        expect(evaluateRule(undefined, "rm -rf", "agent")).toBeUndefined()
    })
})

describe("a verdict names its source", () => {
    test("ties report the profile, not the agent", () => {
        // Both deny; telling the user their AGENT denied it sends them to edit
        // the wrong file, and removing the agent rule would change nothing.
        expect(resolveVerdict(false, false, "ls").source?.layer).toBe("profile")
    })

    test("the reported layer is the one that produced the verdict", () => {
        expect(resolveVerdict(true, false, "ls").source?.layer).toBe("agent")
        expect(resolveVerdict(false, true, "ls").source?.layer).toBe("profile")
    })

    test("a bare rule carries no pattern", () => {
        // Nothing matched a glob — there is no pattern to show, and inventing
        // one would put a fake rule in front of the user.
        expect(resolveVerdict(false, undefined, "ls").source?.pattern).toBeUndefined()
    })
})

describe("isolation intersects as a tier", () => {
    test("an agent cannot drop below its profile", () => {
        expect(resolveIsolation("hardened", "none")).toBe("hardened")
        expect(resolveIsolation("auto", "none")).toBe("auto")
    })

    test("an agent may harden beyond its profile", () => {
        expect(resolveIsolation("none", "hardened")).toBe("hardened")
    })

    test("an undeclared layer defers to the other", () => {
        expect(resolveIsolation(undefined, "auto")).toBe("auto")
        expect(resolveIsolation("auto", undefined)).toBe("auto")
        expect(resolveIsolation(undefined, undefined)).toBeUndefined()
    })
})

/**
 * The glob matcher is duplicated from the capsule's, deliberately — this
 * package is the contract every runtime package depends on and must not import
 * from one. That duplication is only safe while the two agree, so this asserts
 * it rather than trusting the comment.
 */
describe("the glob matcher matches the capsule's", () => {
    const cases: Array<[pattern: string, value: string, expected: boolean]> = [
        ["git *", "git status", true],
        // A literal SPACE is literal. The chained-replace implementation used
        // a space as its `**` placeholder and then rewrote every space to
        // `.*`, so `"bun run *"` compiled to `bun.*run.*[^/]*` and allowed
        // `bun-run-anything` — an allowlist granting far more than it named.
        ["git *", "git", false],
        ["bun run *", "bun-run-anything", false],
        ["bun run *", "bun run test", true],
        ["git push*", "gitXpush", false],
        ["git push*", "git push origin", true],
        // `*` stops at a separator; `**` crosses it. This is the distinction
        // every path rule depends on.
        ["*", "a/b", false],
        ["**", "a/b", true],
        ["data/*", "data/file", true],
        ["data/*", "data/sub/file", false],
        ["data/**", "data/sub/file", true],
        ["**/secrets/**", "a/b/secrets/key", true],
        ["**/secrets/**", "secrets/key", false],
        // Regex metacharacters in a pattern are literal, or a host rule with a
        // dot would match far more than it named.
        ["api.example.com", "apiXexample.com", false],
        ["api.example.com", "api.example.com", true],
        ["*.example.com:443", "api.example.com:443", true],
    ]

    for (const [pattern, value, expected] of cases) {
        test(`${JSON.stringify(pattern)} vs ${JSON.stringify(value)} → ${expected}`, () => {
            expect(policyGlobMatch(pattern, value)).toBe(expected)
        })
    }
})

/**
 * The ceiling under two GLOB rules — the case that used to leak.
 *
 * `pairRule` collapsed here: when both layers were glob-shaped it returned the
 * agent's rule and dropped the profile's, so an agent allowlist silently
 * widened past its profile. These assert the pair is carried instead, and that
 * evaluating it re-applies the ceiling at the moment there is a subject.
 */
describe("a carried rule pair", () => {
    const pair = { profile: { allow: ["git status"] }, agent: { allow: ["git push --force"] } }

    test("denies a command only the agent allowed", () => {
        // THE BUG: this returned allow, and the force-push ran.
        expect(evaluateRule(pair, "git push --force", "agent")?.verdict).toBe("deny")
    })

    test("denies a command only the profile allowed", () => {
        expect(evaluateRule(pair, "git status", "agent")?.verdict).toBe("deny")
    })

    test("allows only what BOTH layers admit", () => {
        const both = { profile: { allow: ["git *"] }, agent: { allow: ["git status"] } }
        expect(evaluateRule(both, "git status", "agent")?.verdict).toBe("allow")
        expect(evaluateRule(both, "git push", "agent")?.verdict).toBe("deny")
    })

    test("names the layer that produced the denial", () => {
        const both = { profile: { allow: ["git *"] }, agent: { allow: ["git status"] } }
        expect(evaluateRule(both, "git push", "agent")?.source?.layer).toBe("agent")
        expect(evaluateRule(pair, "npm install", "agent")?.source?.layer).toBe("profile")
    })

    test("is recognised as a pair rather than a glob rule", () => {
        expect(isRulePair(pair)).toBe(true)
        expect(isRulePair({ allow: ["git *"] })).toBe(false)
        expect(isRulePair(true)).toBe(false)
        expect(isRulePair(undefined)).toBe(false)
    })
})
