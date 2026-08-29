import { isRulePair } from "./policy"
import { evaluateRule, policyGlobMatch, type PolicyVerdict, type ResolvedVerdict } from "./policy-resolve"
import type { EffectiveRule, ResolvedCapsulePolicy } from "./policy"

/**
 * Deciding whether a program may run.
 *
 * ── Why this is not a glob against the command string ───────────────────────
 *
 * The old `process.run` rule matched one pattern against the whole command
 * line, which is not enforceable against anything that is trying. The same
 * effect reaches the same binary as `git push --force`, `git  push --force`
 * (two spaces), `env git push --force`, `/usr/bin/git push --force`, or
 * `sh -c "git push --force"` — and a string matcher catches the first spelling
 * only. An allowlist four spellings defeat is a linter wearing a security
 * label.
 *
 * So the decision is made on the PROGRAM, normalised to a bare binary name
 * before matching, with argument patterns as an explicitly secondary layer.
 * Lives in @arcforge/types because the mediator, the capsule and `axon policy`
 * must all answer this identically.
 */

/** The shells whose whole purpose is to run an arbitrary command string. */
const SHELLS = new Set([
    "sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash", "busybox",
])

/**
 * Argv-ish wrappers that run ANOTHER program, hiding it from a naive read of
 * argv[0].
 *
 * `env FOO=1 git push` execs git; a check that only looked at `env` would admit
 * it. Each entry names how many leading tokens to skip before the real program
 * appears — `env` takes assignments, so its tail is scanned rather than counted.
 */
const WRAPPERS = new Set(["env", "nice", "nohup", "stdbuf", "setsid", "time", "timeout", "xargs"])

/** A program name stripped of its path: `/usr/bin/git` → `git`. */
export function programName(program: string): string {
    const base = program.split("/").pop() ?? program
    return base
}

/**
 * The program a command line actually executes, seeing through wrappers.
 *
 * Returns the resolved program plus whether a SHELL was reached — the caller
 * needs both, because a shell is gated by `raw` rather than by `allow`.
 */
export function resolveProgram(argv: string[]): { program: string; shell: boolean; via: string[] } {
    const via: string[] = []
    let index = 0

    while (index < argv.length) {
        const name = programName(argv[index]!)
        if (!WRAPPERS.has(name)) break
        via.push(name)
        index++
        // `env` may carry KEY=VALUE assignments before the program.
        if (name === "env") {
            while (index < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[index]!)) index++
        }
        // `timeout`/`nice` take a leading numeric/flag argument.
        if ((name === "timeout" || name === "nice") && index < argv.length && /^-?\d/.test(argv[index]!)) index++
    }

    const program = programName(argv[index] ?? "")
    return { program, shell: SHELLS.has(program), via }
}

export type ShellDecision = {
    verdict: PolicyVerdict
    /** The program the decision was made about, after unwrapping. */
    program: string
    /** Why, for the audit record and the model-facing denial. */
    reason: "raw-shell" | "denied" | "not-allowed" | "args" | "allowed" | "no-policy"
    source?: ResolvedVerdict["source"]
}

/**
 * Decide one execution against the resolved `shell` policy.
 *
 * Order is deliberate and each step is a different question:
 *   1. Is this a shell, and is `raw` off? A shell defeats every rule below it,
 *      so it is answered first and separately.
 *   2. Does `deny` name the program? Deny always beats allow.
 *   3. Does `allow` admit it? An allowlist that names nothing matching is a
 *      denial — the same "declared, matched nothing" rule the glob resolver uses.
 *   4. Do the argument patterns object? Advisory, and last.
 */
export function decideShell(
    shell: ResolvedCapsulePolicy["shell"],
    argv: string[],
    /**
     * What an UNDECLARED `shell` surface means.
     *
     * The two callers sit on opposite sides of a trust boundary and need
     * opposite answers, which is why this is a parameter rather than a constant:
     *
     *   "deny"  — the CAPSULE. It runs foreign, model-emitted code and must
     *             never grant capability by omission. A bare `Capsule()` with no
     *             policy can run nothing.
     *   "allow" — AXON. It is wiring a box for its own declared blueprint, and
     *             "I did not set a security policy" means a personal tool with
     *             the user's own privileges, not a brick.
     *
     * Getting this wrong in either direction is silent: one bricks every
     * unconfigured capsule, the other hands an unconfigured sandbox a shell.
     */
    fallback: "allow" | "deny" = "deny",
): ShellDecision {
    // No shell block at all: the caller's own default posture decides.
    if (!shell) return { verdict: fallback, program: programName(argv[0] ?? ""), reason: "no-policy" }

    const { program, shell: isShell } = resolveProgram(argv)

    // A shell turns one grant into arbitrary execution. Gated on its own switch
    // so `allow: ["git"]` cannot be quietly widened by `sh` being on the box.
    if (isShell && shell.raw !== true) {
        return { verdict: "deny", program, reason: "raw-shell" }
    }

    if (shell.deny?.some(pattern => policyGlobMatch(pattern, program))) {
        return { verdict: "deny", program, reason: "denied" }
    }

    if (shell.allow !== undefined) {
        const admitted = shell.allow.some(pattern => policyGlobMatch(pattern, program))
        if (!admitted) return { verdict: "deny", program, reason: "not-allowed" }
    }

    // Argument patterns — advisory, and only consulted once the program itself
    // is admitted. A rule here can still escalate or deny.
    //
    // Evaluated as a FILTER over an already-admitted program, not as an
    // allowlist. `evaluateRule` treats "declared, matched nothing" as a denial,
    // which is right for a rule that decides whether a capability exists at all
    // and wrong here: `args: { git: { deny: ["push --force*"] } }` states one
    // thing about `git push --force` and nothing whatsoever about `git status`.
    // Reading its silence as a denial would mean naming a single forbidden flag
    // silently forbade every other use of the program.
    const argRule: EffectiveRule | undefined = shell.args?.[program]
    if (argRule !== undefined) {
        // Match against the argv TAIL — everything after the program itself —
        // so a pattern reads as the arguments a user would type, not as a
        // command line whose leading path they have to predict.
        const at = argv.findIndex(entry => programName(entry) === program)
        const tail = argv.slice(at + 1).join(" ")
        const resolved = evaluateRule(argRule, tail, "agent")
        const matched = resolved?.source?.pattern !== undefined || typeof argRule !== "object" || isRulePair(argRule)
        if (resolved && resolved.verdict !== "allow" && matched) {
            return { verdict: resolved.verdict, program, reason: "args", ...(resolved.source ? { source: resolved.source } : {}) }
        }
    }

    return { verdict: "allow", program, reason: "allowed" }
}

/**
 * Split a command STRING into argv for the decision above.
 *
 * Deliberately simple: it honours quotes so `git commit -m "a b"` is three
 * arguments, and nothing else. It is not a shell parser and must never become
 * one — if a caller needs `$(...)`, pipes or globbing expanded, what they
 * actually have is a shell invocation, which `raw` governs.
 */
export function splitCommand(command: string): string[] {
    const argv: string[] = []
    let current = ""
    let quote: '"' | "'" | null = null
    let has = false

    for (const char of command) {
        if (quote) {
            if (char === quote) quote = null
            else current += char
            continue
        }
        if (char === '"' || char === "'") { quote = char; has = true; continue }
        if (/\s/.test(char)) {
            if (current || has) { argv.push(current); current = ""; has = false }
            continue
        }
        current += char
    }
    if (current || has) argv.push(current)
    return argv
}
