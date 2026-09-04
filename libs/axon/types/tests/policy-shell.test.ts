import { describe, expect, test } from "bun:test"
import { decideShell, resolveProgram, splitCommand } from "../src/policy-shell"

/**
 * The bypasses the old command-string matcher admitted.
 *
 * `process.run: { allow: ["git *"] }` compiled to one regex against the whole
 * command line. Every case below reached the same binary by a spelling that
 * regex did not describe, which is why the unit of enforcement moved to the
 * program.
 */
describe("resolving the program a command actually runs", () => {
    test("sees through env and its assignments", () => {
        expect(resolveProgram(["env", "FOO=1", "BAR=2", "git", "push"]).program).toBe("git")
    })

    test("sees through nice, nohup, setsid, stdbuf", () => {
        for (const wrapper of ["nice", "nohup", "setsid", "stdbuf"]) {
            expect(resolveProgram([wrapper, "git", "push"]).program).toBe("git")
        }
    })

    test("sees through timeout and its numeric argument", () => {
        expect(resolveProgram(["timeout", "30", "git", "push"]).program).toBe("git")
    })

    test("strips the path so an absolute invocation is the same program", () => {
        expect(resolveProgram(["/usr/bin/git", "push"]).program).toBe("git")
    })

    test("identifies a shell as a shell, however it is spelled", () => {
        for (const shell of ["sh", "bash", "zsh", "/bin/bash", "dash"]) {
            expect(resolveProgram([shell, "-c", "git push"]).shell).toBe(true)
        }
        expect(resolveProgram(["git", "push"]).shell).toBe(false)
    })
})

describe("shell policy decisions", () => {
    const policy = { allow: ["git", "bun"], deny: [], raw: false }

    test("allows a named program", () => {
        expect(decideShell(policy, ["git", "status"]).verdict).toBe("allow")
    })

    test("escalates a program the allowlist does not name", () => {
        // NOT admitted — that is the security property, and it is unchanged.
        // What changed is what "not admitted" means when the user has said
        // nothing about this program: `allow: ["git"]` states that git is
        // permitted and says nothing whatsoever about curl, so reading its
        // silence as a refusal left the user editing a config file with no
        // prompt to answer. Escalation asks; "always" writes the grant.
        const decision = decideShell(policy, ["curl", "https://example.com"])
        expect(decision.verdict).toBe("escalate")
        expect(decision.reason).toBe("not-allowed")
    })

    test("denies a raw shell even when the shell would run an allowed program", () => {
        // THE BYPASS: `git` is allowed, so a command-string matcher would see
        // "git push" inside the -c argument and admit the whole invocation.
        const decision = decideShell(policy, ["sh", "-c", "git push --force"])
        expect(decision.verdict).toBe("deny")
        expect(decision.reason).toBe("raw-shell")
    })

    test("denies a shell reached through a wrapper", () => {
        expect(decideShell(policy, ["env", "bash", "-c", "rm -rf /"]).reason).toBe("raw-shell")
    })

    test("allows a shell when raw is granted AND the shell is allowlisted", () => {
        expect(decideShell({ allow: ["sh"], raw: true }, ["sh", "-c", "git push"]).verdict).toBe("allow")
    })

    test("allows a piped command when both every program and raw shell syntax are granted", () => {
        const command = 'grep -h "omarchy:summary=" /usr/bin/omarchy-* 2>/dev/null | head -12'
        const decision = decideShell({ allow: ["*"], raw: true }, splitCommand(command), "deny", command)

        expect(decision).toMatchObject({ verdict: "allow", program: "grep" })
    })

    test("raw alone does not bypass the allowlist", () => {
        // `raw` says a shell is permissible in principle; `allow` still decides
        // which programs exist. Granting one must not silently grant the other.
        //
        // The anti-laundering property is what matters and it holds: `git push`
        // through a shell is NOT admitted on the strength of `raw` alone. It
        // now asks rather than refusing outright, which is a different answer
        // to "has the user decided?" and the same answer to "is this allowed?".
        const decision = decideShell({ ...policy, raw: true }, ["sh", "-c", "git push"])
        expect(decision.verdict).not.toBe("allow")
        expect(decision.reason).toBe("not-allowed")
    })

    test("does not launder a disallowed program through env", () => {
        // `env curl ...` must not slip curl past an allowlist naming git. The
        // unwrapping is the point: the decision is made about `curl`, not
        // about `env`, so it cannot be admitted by wrapping.
        const decision = decideShell(policy, ["env", "curl", "https://x"])
        expect(decision.verdict).not.toBe("allow")
        expect(decision.program).toBe("curl")
    })

    test("deny beats allow for the same program", () => {
        expect(decideShell({ allow: ["git"], deny: ["git"], raw: false }, ["git", "status"]).verdict).toBe("deny")
    })

    test("argument patterns gate an otherwise-allowed program", () => {
        const withArgs = { ...policy, args: { git: { deny: ["push --force*"] } } }
        expect(decideShell(withArgs, ["git", "status"]).verdict).toBe("allow")
        const denied = decideShell(withArgs, ["git", "push", "--force"])
        expect(denied.verdict).toBe("deny")
        expect(denied.reason).toBe("args")
    })

    test("argument patterns match the same tail however the program was spelled", () => {
        // The whitespace and absolute-path spellings that defeated the old
        // command-string regex resolve to one subject here.
        const withArgs = { ...policy, args: { git: { deny: ["push --force*"] } } }
        expect(decideShell(withArgs, ["/usr/bin/git", "push", "--force"]).verdict).toBe("deny")
        expect(decideShell(withArgs, ["env", "git", "push", "--force"]).verdict).toBe("deny")
    })

    test("an undeclared surface defers to the caller's own posture", () => {
        // The two callers sit on opposite sides of a trust boundary. The
        // capsule runs foreign model-emitted code and must never grant by
        // omission; Axon is wiring a box for its own blueprint, where "I set no
        // policy" means a personal tool with the user's privileges. Neither
        // default is right for both, so it is a parameter.
        expect(decideShell(undefined, ["anything"]).verdict).toBe("deny")
        expect(decideShell(undefined, ["anything"], "deny").verdict).toBe("deny")
        expect(decideShell(undefined, ["anything"], "allow").verdict).toBe("allow")
    })

    test("an empty allowlist denies everything", () => {
        expect(decideShell({ allow: [], deny: ["*"], raw: false }, ["git"]).verdict).toBe("deny")
    })
})

describe("splitting a command string", () => {
    test("honours quotes so a quoted argument stays one token", () => {
        expect(splitCommand('git commit -m "a b c"')).toEqual(["git", "commit", "-m", "a b c"])
    })

    test("collapses repeated whitespace — the two-space bypass", () => {
        expect(splitCommand("git  push   --force")).toEqual(["git", "push", "--force"])
    })

    test("keeps an empty quoted argument", () => {
        expect(splitCommand('git commit -m ""')).toEqual(["git", "commit", "-m", ""])
    })
})

/**
 * Silence asks; a written rule decides.
 *
 * The distinction the whole default rests on. A user who wrote `deny: ["curl"]`
 * or `raw: false` has made a decision, and re-asking would be ignoring them.
 * A user who wrote neither has decided nothing, and a flat refusal sends them
 * to a config file with no prompt to answer — the moment someone gives up and
 * uses a different tool.
 */
describe("shell policy: silence versus decision", () => {
    test("an unset `raw` escalates rather than refusing", () => {
        // Every `process.run(...)` goes through `/bin/sh -c`, so a hard deny
        // here meant an agent with no shell policy could not run one command,
        // citing a rule its author never wrote.
        const decision = decideShell({ allow: ["*"] }, ["sh", "-c", "echo hi"])
        expect(decision.verdict).toBe("escalate")
        expect(decision.reason).toBe("raw-shell")
    })

    test("`raw: false` is still an absolute refusal", () => {
        // Written down. Asking again would be overruling the person who wrote it.
        const decision = decideShell({ allow: ["*"], raw: false }, ["sh", "-c", "echo hi"])
        expect(decision.verdict).toBe("deny")
        expect(decision.reason).toBe("raw-shell")
    })

    test("`deny` naming the program is still an absolute refusal", () => {
        const decision = decideShell({ allow: ["*"], deny: ["curl"] }, ["curl", "https://x"])
        expect(decision.verdict).toBe("deny")
        expect(decision.reason).toBe("denied")
    })

    test("an allowlist that names the program still allows it outright", () => {
        // The common path must not start prompting.
        expect(decideShell({ allow: ["git"] }, ["git", "status"]).verdict).toBe("allow")
    })

    test("a wildcard allowlist admits without asking", () => {
        expect(decideShell({ allow: ["*"] }, ["axon", "@x/y", "-p", "hi"]).verdict).toBe("allow")
    })
})


/**
 * Chaining must not be a way around a deny.
 *
 * `process.run()` and `process.spawn()` hand the WHOLE command string to
 * `/bin/sh -c`. The decision, though, was made about `resolveProgram(argv)` —
 * the FIRST program on the line. So every deny was one `&&` away from being
 * bypassed, and this was found in a live session: an agent whose config had
 * just been changed to disallow git ran
 *
 *     process.run("pwd && git status --short --branch && git remote -v")
 *
 * and got exitCode 0. The policy decided about `pwd`; the shell ran git.
 *
 * The fix is not a better parser — the header of policy-shell.ts already
 * rejects that road, and rightly: a matcher that understands four spellings is
 * defeated by the fifth. A string carrying shell metacharacters IS a shell
 * invocation, so it is answered by `raw`, which already exists and already
 * escalates to the user.
 */
describe("decideShell: command chaining cannot bypass a deny", () => {
    const policy = { allow: ["*"], deny: ["git"], raw: false }

    /** Every operator that makes one string run more than one program. */
    const chained = [
        "pwd && git status",
        "pwd; git push --force",
        "pwd || git status",
        "echo x | git apply",
        "pwd & git status",
        "echo $(git rev-parse HEAD)",
        "echo `git rev-parse HEAD`",
        "git status > /tmp/out",
        "pwd\ngit status",
    ]

    for (const command of chained) {
        test(`refuses ${JSON.stringify(command)}`, () => {
            const decision = decideShell(policy, splitCommand(command), "allow", command)

            expect(decision.verdict).toBe("deny")
            // As a SHELL, not as its first program — the honest reason, and
            // the one that tells a model how to rewrite the call.
            expect(decision.reason).toBe("raw-shell")
        })
    }

    test("the reported failure, verbatim", () => {
        const command = "pwd && git status --short --branch && git remote -v"

        expect(decideShell(policy, splitCommand(command), "allow", command).verdict).toBe("deny")
    })

    test("escalates rather than denying when `raw` was never set", () => {
        // Silence is not a decision. A user who never wrote a shell policy
        // gets asked — bricking every chained command would be a rule its
        // author never wrote.
        const decision = decideShell({ allow: ["*"], deny: ["git"] }, splitCommand("pwd && git status"), "allow", "pwd && git status")

        expect(decision.verdict).toBe("escalate")
        expect(decision.reason).toBe("raw-shell")
    })

    test("`raw: true` is the user opting in, and is honoured", () => {
        // Declaring raw shells means declaring arbitrary execution. That is a
        // decision someone made deliberately, and the point of the switch.
        const decision = decideShell({ allow: ["*"], deny: ["git"], raw: true }, splitCommand("pwd && git status"), "allow", "pwd && git status")

        expect(decision.verdict).toBe("allow")
    })

    test("an ordinary command is untouched", () => {
        // The fix must not turn every call into a prompt — that is how a
        // security control gets switched off wholesale.
        for (const command of ["git status", "ls -la", "pwd", `git commit -m "a b"`, "npm run build"]) {
            const decision = decideShell({ allow: ["*"], raw: false }, splitCommand(command), "allow", command)
            expect(decision.reason).not.toBe("raw-shell")
        }
    })

    test("a quoted metacharacter is still an argument, not a chain", () => {
        // `echo "a && b"` runs one program. Treating the quoted text as a
        // chain would prompt on a command that does exactly one thing.
        const decision = decideShell({ allow: ["*"], raw: false }, splitCommand(`echo "a && b"`), "allow", `echo "a && b"`)

        expect(decision.reason).not.toBe("raw-shell")
    })
})
