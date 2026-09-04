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

/**
 * Characters that make a command line a SHELL PROGRAM rather than one call.
 *
 * `&&`, `;`, `|`, `||` chain commands; `$(…)` and backticks substitute one;
 * `>`/`<` redirect; `&` backgrounds. Every one of them means the string
 * executes something the first token does not name.
 *
 * This is not a lint. `process.run()` and `process.spawn()` hand the WHOLE
 * string to `/bin/sh -c`, so a policy that inspected only the first program
 * was deciding about `pwd` while the shell ran `pwd && git push --force`.
 * Every deny was one `&&` away from being bypassed:
 *
 *     process.run("git status")               → denied, correctly
 *     process.run("pwd && git status")        → ALLOWED, ran git
 *
 * Detected here rather than by parsing, because parsing is the trap the file
 * header already names: a matcher that understands four spellings is defeated
 * by the fifth. The honest answer is that a string containing these is a shell
 * invocation, and shells are governed by `raw` — which exists, and already
 * escalates to the user.
 */
const SHELL_META = /[;&|<>`$()\n]/

/**
 * Does this COMMAND STRING invoke a shell?
 *
 * Answered on the raw string, never on split tokens, because splitting
 * destroys both halves of the question:
 *
 *   - it drops newlines as ordinary whitespace, so `"pwd\ngit status"` — two
 *     commands to `/bin/sh -c` — arrives as three innocent tokens;
 *   - it strips quotes, so `echo "a && b"` yields a token containing `&&`
 *     that a token-level test reads as a chain, prompting on a command that
 *     does exactly one thing.
 *
 * So quoted regions are skipped and everything outside them is examined —
 * which is precisely the distinction a shell itself makes.
 */
export function isShellCommand(command: string): boolean {
    let quote: '"' | "'" | null = null

    for (let i = 0; i < command.length; i++) {
        const char = command[i]!
        if (quote) {
            // A backslash-escaped quote inside a double-quoted region does not
            // close it. Single quotes take no escapes, exactly as sh does.
            if (char === "\\" && quote === '"') { i++; continue }
            if (char === quote) quote = null
            continue
        }
        if (char === '"' || char === "'") { quote = char; continue }
        // Escaped outside quotes: `\&` is a literal ampersand, not an operator.
        if (char === "\\") { i++; continue }
        if (SHELL_META.test(char)) return true
    }
    return false
}

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
    /**
     * The command as the caller received it, before splitting.
     *
     * Required to see a chain. `process.run()`/`spawn()` hand the whole string
     * to `/bin/sh -c`, and splitting destroys the evidence — a newline becomes
     * whitespace, a quote disappears. Callers holding a string MUST pass it;
     * a caller holding genuine argv (never a shell line) may omit it.
     */
    command?: string,
): ShellDecision {
    // No shell block at all: the caller's own default posture decides.
    if (!shell) return { verdict: fallback, program: programName(argv[0] ?? ""), reason: "no-policy" }

    const { program, shell: resolvedShell } = resolveProgram(argv)

    // A chained/redirected/substituted command line is a SHELL PROGRAM, whatever
    // its first token is — see isShellCommand. Without this the decision was
    // made about `pwd` while `/bin/sh -c` ran `pwd && git push --force`.
    const isShell = resolvedShell || (command !== undefined && isShellCommand(command))

    /**
     * A shell turns one grant into arbitrary execution. Gated on its own switch
     * so `allow: ["git"]` cannot be quietly widened by `sh` being on the box.
     *
     * ESCALATES rather than denying when `raw` is simply unset. `raw: false`
     * is still an absolute refusal — a user who wrote it said no — but silence
     * is not a decision, and a hard deny here bricked the common case: every
     * `process.run(...)` goes through `/bin/sh -c`, so an agent with no shell
     * policy could not run a single command and the error named a rule its
     * author had never written. Asking is the honest answer to a question
     * nobody has answered, and the prompt can say what a shell actually is.
     */
    if (isShell && shell.raw !== true) {
        if (shell.raw === false) return { verdict: "deny", program, reason: "raw-shell" }
        return { verdict: "escalate", program, reason: "raw-shell" }
    }

    // Deny always beats allow, and always means DENY: this one is a rule
    // somebody wrote, naming this program. There is nothing to ask about.
    if (shell.deny?.some(pattern => policyGlobMatch(pattern, program))) {
        return { verdict: "deny", program, reason: "denied" }
    }

    if (shell.allow !== undefined) {
        /**
         * An allowlist that names nothing matching ESCALATES.
         *
         * It used to be a flat denial, on the "declared, matched nothing" rule
         * the glob resolver uses. That rule is right for a resolver and wrong
         * here: `allow: ["git"]` states that git is permitted and says nothing
         * whatsoever about `axon`, and reading its silence as a refusal left a
         * user with no way forward but to go and edit a config file — the
         * moment a new user gives up and uses something else.
         *
         * Escalation is what the ceiling is FOR. The prompt names the program,
         * and answering "always" writes the grant the user would have gone
         * looking for.
         */
        const admitted = shell.allow.some(pattern => policyGlobMatch(pattern, program))
        if (!admitted) return { verdict: "escalate", program, reason: "not-allowed" }
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
