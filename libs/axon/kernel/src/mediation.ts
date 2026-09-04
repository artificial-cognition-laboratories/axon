import { randomUUID } from "node:crypto"
import { decideShell, evaluateRule, isMemberBag, splitCommand } from "@arcforge/types"
import type { AxonEscalate, EffectiveRule, ResolvedCapsulePolicy, ShellDecision } from "@arcforge/types"
import type { AxonSessionT } from "@arcforge/session"

/**
 * Mediation — the policy gate and audit trail for tools running IN this
 * process.
 *
 * The counterpart to the capsule's guest-side `Mediator`, which cannot serve
 * an in-process tool: it lives inside the subprocess and answers over a wire.
 * Same decisions, same event vocabulary, no boundary.
 *
 * ── What this layer is, once the OS wall exists ─────────────────────────────
 *
 * In the capsule this WAS the security boundary. Once the whole agent runs
 * inside a box, bwrap is the wall — a path outside the policy does not exist, a
 * denied network has no socket — and this becomes the AUDIT and ESCALATION
 * layer. That is a demotion, not a removal: the OS cannot say "ask the user
 * about this one command", and a denial arriving as ENOENT teaches the model
 * nothing. A typed refusal it can reason about is worth more than a syscall
 * error it cannot.
 *
 * Deny-by-default is preserved exactly: a call with no matching rule is
 * refused. A mediator must never grant capability by omission.
 */

type MediationOpts = {
    policy: () => ResolvedCapsulePolicy
    session: AxonSessionT
    /** The platform's decider. Absent = nobody to ask, which means deny. */
    escalate?: AxonEscalate
    /** Correlates each span to the run that caused it, when one is active. */
    run?: () => { runId: string } | null
    /**
     * The capsule block currently executing, or null outside one.
     *
     * A tool call happens INSIDE a block, so every span and every denial this
     * layer records belongs to one. The id lives in the capsule's execution
     * store; this reads it so a surface can hang a refusal under the
     * `Run(...)` that provoked it. Every span here committed `commandId: ""`
     * before, which is why a denied tool call was an orphan on the log.
     */
    commandId?: () => string | null
}

/** How long an unanswered escalation waits before failing closed. */
const ESCALATION_TIMEOUT_MS = 30_000

const POLICY_WILDCARD = "*"

export function Mediation(opts: MediationOpts) {
    /** The block this call belongs to — "" when there is none, as the span shape expects. */
    function commandId(): string {
        return opts.commandId?.() ?? ""
    }

    /**
     * Resolve which rule governs a call, by walking its ADDRESS.
     *
     * `process.spawn`/`process.run` are the two built-in verbs, resolved by
     * exact name. Everything else is a tool, addressed exactly as the code
     * addresses it — the policy map mirrors the agent's global scope
     * one-for-one, so a rule and a call site are the same string.
     *
     * Most specific first:
     *   `fs.remove` → `tools["fs"]["remove"]` → `tools["fs"]` → `tools["*"]`
     *   `read`      → `tools["read"]`                        → `tools["*"]`
     *
     * A bag entry (`fs: { read: true }`) can only carry rules one level
     * deep, matching the scope: a global is a function or a bag of
     * functions, never deeper.
     */
    function ruleFor(fn: string): EffectiveRule | undefined {
        const policy = opts.policy()

        // `shell.spawn` is the one built-in verb still decided by a rule.
        // `shell.run` is not here: execution is decided by decideShell(), which
        // reasons about the PROGRAM rather than glob-matching a command string.
        if (fn === "shell.spawn") {
            const spawn = policy.shell?.spawn
            if (spawn !== null && typeof spawn === "object" && "rule" in spawn) return spawn.rule
            return spawn as EffectiveRule | undefined
        }

        const tools = policy.tools
        if (!tools) return undefined

        const [head, member] = splitAddress(fn)
        const entry = tools[head]

        if (isMemberBag(entry)) {
            // A bag with no rule for this member is not a miss — the bag
            // itself is the statement about everything under it, and falling
            // through to `*` would let a wildcard override a rule the author
            // wrote about this exact tool.
            if (member !== undefined && member in entry) return entry[member]
            return tools[POLICY_WILDCARD]
        }

        return entry ?? tools[POLICY_WILDCARD]
    }

    /**
     * `fn` is the ADDRESS policy resolves against; `owner` is the module the
     * export came from, carried for the audit record only. They were once the
     * same idea — policy keyed on the owning namespace — which is why a rule
     * about `fs` could not distinguish `fs.read` from a bare `read` shipped
     * by a different module.
     */
    async function check(fn: string, subject: string, args: unknown[], owner: string): Promise<boolean> {
        const rule = ruleFor(fn)
        const resolved = evaluateRule(rule, subject, "agent")
        const verdict = resolved?.verdict ?? "deny"

        if (verdict === "allow") return true

        if (verdict === "deny") {
            await opts.session.commit("process:policy:denied", {
                id: randomUUID(), commandId: commandId() || null, module: owner, fn, args, rule: String(rule),
            }, span())
            return false
        }

        // Escalate — a human decision, and the one thing the OS wall cannot
        // express. Fails CLOSED, and RECORDS the timeout: this layer's whole
        // remaining job is escalation and audit, so an escalation that expired
        // with nothing written is a hole in its only function.
        const id = randomUUID()
        await opts.session.commit("process:policy:escalation", {
            id, commandId: commandId() || null, module: owner, fn, args, rule: String(rule),
        }, span())

        const started = Date.now()
        const allow = await decide(id, fn, args)
        await opts.session.commit("process:policy:decision", {
            id, allow, durationMs: Date.now() - started,
        }, span())
        // A refused escalation is a DENIAL and says so on the record. The
        // decision event alone says WHAT was answered; only this says the call
        // did not happen, which is the fact a surface renders.
        if (!allow) {
            /**
             * "Nobody was there to ask" is a different fact from "a person said
             * no", and only one of them has a fix.
             *
             * A headless run — a script, CI, the subagent module shelling out —
             * has no decider, so every escalation dies. Reporting that as a
             * refusal sends the reader looking for a decision nobody made. It
             * names the grant instead, the same way `withheldMessage` does for
             * an env var: deny-by-default is only adoptable when its denials
             * say which line to write.
             */
            await opts.session.commit("process:policy:denied", {
                id: randomUUID(), commandId: commandId() || null, module: owner, fn, args,
                rule: headless() ? "escalation-headless" : "escalation-denied",
            }, span())
        }
        return allow
    }

    /** True when this run has nobody to ask — a script, CI, a headless invocation. */
    function headless(): boolean {
        return !opts.escalate
    }

    function decide(id: string, fn: string, args: unknown[]): Promise<boolean> {
        // No decider attached (a script, a headless run) means nobody to ask,
        // and an unanswered escalation must never read as permission.
        if (!opts.escalate) return Promise.resolve(false)

        return new Promise<boolean>(resolve => {
            let settled = false
            const settle = (allow: boolean) => {
                if (settled) return
                settled = true
                clearTimeout(timer)
                resolve(allow)
            }
            const timer = setTimeout(() => settle(false), ESCALATION_TIMEOUT_MS)

            void Promise.resolve(opts.escalate!({ id, fn, args, rule: "escalate" }))
                .then(allow => settle(allow === true))
                // A decider that threw has not granted anything. Same posture
                // as a timeout: closed.
                .catch(() => settle(false))
        })
    }

    function span() {
        const active = opts.run?.()
        return active ? { runId: active.runId, spanId: Bun.randomUUIDv7() } : undefined
    }

    /**
     * Decide one program execution.
     *
     * Separate from `check` because the QUESTION is different: `check` resolves
     * an address to a rule and matches a subject against it, while this
     * resolves an argv to the program it actually runs — seeing through `env`,
     * `nice`, an absolute path, or a shell — and decides on that. The old
     * `process.run` rule tried to do it as a glob over the command string, and
     * four spellings of one command defeated it.
     *
     * Escalation still routes through the same decider, so a `"escalate"`
     * verdict on an argument pattern prompts exactly like any other.
     */
    async function shell(argv: string[], owner: string, command?: string): Promise<ShellDecision> {
        // Axon's posture: an agent whose blueprint declares no shell policy is
        // a personal tool with the user's own privileges. The capsule's is the
        // opposite — see decideShell's `fallback`.
        //
        // `command` is the unsplit line, and only a caller that HAS one passes
        // it: a chain is invisible once split (a newline becomes whitespace, a
        // quote disappears), and deciding without it means deciding about the
        // first program while `/bin/sh -c` runs the rest.
        const decision = decideShell(opts.policy().shell, argv, "allow", command)
        if (decision.verdict === "allow") return decision

        const fn = `shell.run:${decision.program}`
        const subject = argv.join(" ")

        if (decision.verdict === "deny") {
            await opts.session.commit("process:policy:denied", {
                id: randomUUID(), commandId: commandId() || null, module: owner, fn, args: argv, rule: decision.reason,
            }, span())
            return decision
        }

        const allowed = await check(fn, subject, argv, owner)
        return allowed ? { ...decision, verdict: "allow" } : { ...decision, verdict: "deny" }
    }

    return {
        check,
        shell,
        /**
         * `shell()` for a command that arrived as a string rather than argv.
         *
         * The string is forwarded ALONGSIDE its argv, because it is the only
         * form in which a chain is still visible — see decideShell.
         */
        shellCommand(command: string, owner: string): Promise<ShellDecision> {
            return shell(splitCommand(command), owner, command)
        },
        /**
         * The span stream every surface reads.
         *
         * The event NAMES are unchanged from the capsule's — Fleet folds its
         * flame graph and `procTree()` reads the process tree straight out of
         * these. Renaming them while moving the machinery is how a flame graph
         * silently stops pairing brackets.
         */
        emit: {
            start(input: { module: string; fn: string; args: unknown[] }) {
                void opts.session.commit("process:fn:start", { commandId: commandId(), ...input }, span())
            },
            complete(input: { module: string; fn: string; result: unknown; durationMs: number }) {
                void opts.session.commit("process:fn:complete", { commandId: commandId(), ...input }, span())
            },
            failed(input: { module: string; fn: string; error: unknown; durationMs: number }) {
                void opts.session.commit("process:fn:failed", {
                    commandId: commandId(),
                    module: input.module,
                    fn: input.fn,
                    error: input.error as never,
                    durationMs: input.durationMs,
                }, span())
            },
        },
    }
}

export type MediationT = ReturnType<typeof Mediation>

/**
 * Split a call address into its head and (optional) member.
 *
 * `fs.read` → ["fs", "read"]; `read` → ["read", undefined]. Only the FIRST
 * dot splits: the scope is one level deep, so anything after it is part of
 * the member name rather than a third level to walk.
 */
function splitAddress(fn: string): [string, string | undefined] {
    const dot = fn.indexOf(".")
    return dot === -1 ? [fn, undefined] : [fn.slice(0, dot), fn.slice(dot + 1)]
}
