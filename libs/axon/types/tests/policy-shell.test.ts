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

    test("denies a program the allowlist does not name", () => {
        const decision = decideShell(policy, ["curl", "https://example.com"])
        expect(decision.verdict).toBe("deny")
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

    test("raw alone does not bypass the allowlist", () => {
        // `raw` says a shell is permissible in principle; `allow` still decides
        // which programs exist. Granting one must not silently grant the other.
        const decision = decideShell({ ...policy, raw: true }, ["sh", "-c", "git push"])
        expect(decision.verdict).toBe("deny")
        expect(decision.reason).toBe("not-allowed")
    })

    test("denies a disallowed program reached through env", () => {
        // `env curl ...` must not launder curl past an allowlist naming git.
        expect(decideShell(policy, ["env", "curl", "https://x"]).verdict).toBe("deny")
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
